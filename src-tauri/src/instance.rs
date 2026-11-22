use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use wasabipad_core::PosC;

use crate::{WindowRequest, EVENT_EXTERNAL_WINDOW_REQUEST};

// Explorerから起動された新プロセスが、既存プロセスのうち最も新しいものへ
// ファイルを渡すためのローカルエンドポイント。
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct InstanceEndpoint {
    port: u16,
    pid: u32,
    started_at: u128,
    token: String,
}

pub(crate) struct InstanceServer {
    listener: Mutex<Option<TcpListener>>,
    endpoint: Option<InstanceEndpoint>,
    pub(crate) pending: Arc<Mutex<Vec<WindowRequest>>>,
}

const INSTANCE_DIR: &str = "instances";
const TOKEN_BYTES: usize = 32;
const CLIENT_NONCE_BYTES: usize = 16;
const AUTH_DIGEST_BYTES: usize = 32;
const ACK_BYTES: &[u8] = b"WASABIPAD_OK\n";
const MAX_WINDOW_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_PENDING_REQUESTS: usize = 64;
const MAX_CONCURRENT_CONNECTIONS: usize = 8;
const WINDOW_REQUEST_DEADLINE: Duration = Duration::from_secs(2);
const CONNECT_TIMEOUT: Duration = Duration::from_millis(250);

struct ActiveConnectionGuard(Arc<AtomicUsize>);

impl ActiveConnectionGuard {
    fn try_acquire(counter: &Arc<AtomicUsize>) -> Option<Self> {
        let mut current = counter.load(Ordering::Acquire);
        loop {
            if current >= MAX_CONCURRENT_CONNECTIONS {
                return None;
            }
            match counter.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Some(Self(Arc::clone(counter))),
                Err(next) => current = next,
            }
        }
    }
}

impl Drop for ActiveConnectionGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

impl InstanceServer {
    pub(crate) fn new() -> io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let address = listener.local_addr()?;
        let endpoint = InstanceEndpoint {
            port: address.port(),
            pid: std::process::id(),
            started_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            token: generate_token()?,
        };
        write_instance_endpoint(&instance_directory(), &endpoint)?;
        Ok(Self {
            listener: Mutex::new(Some(listener)),
            endpoint: Some(endpoint),
            pending: Arc::new(Mutex::new(Vec::new())),
        })
    }

    pub(crate) fn disabled() -> Self {
        Self {
            listener: Mutex::new(None),
            endpoint: None,
            pending: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub(crate) fn start(&self, app: &AppHandle) {
        let listener = match self.listener.lock() {
            Ok(mut listener) => listener.take(),
            Err(poisoned) => {
                eprintln!("インスタンス受付のロックが壊れたため、既存状態を保持して復旧します");
                poisoned.into_inner().take()
            }
        };
        let (Some(listener), Some(endpoint)) = (listener, self.endpoint.clone()) else {
            return;
        };
        let pending = Arc::clone(&self.pending);
        let app = app.clone();
        let active_connections = Arc::new(AtomicUsize::new(0));
        std::thread::spawn(move || {
            for incoming in listener.incoming() {
                let Ok(stream) = incoming else { continue };
                let Some(guard) = ActiveConnectionGuard::try_acquire(&active_connections) else {
                    continue;
                };
                let token = endpoint.token.clone();
                let pending = Arc::clone(&pending);
                let app = app.clone();
                std::thread::spawn(move || {
                    let _guard = guard;
                    if handle_incoming_connection(stream, &token, &pending) {
                        if let Err(error) = app.emit(EVENT_EXTERNAL_WINDOW_REQUEST, ()) {
                            eprintln!("外部起動要求の通知に失敗しました: {error}");
                        }
                    }
                });
            }
        });
    }

    pub(crate) fn remove_endpoint(&self) {
        let Some(endpoint) = &self.endpoint else {
            return;
        };
        let path = instance_endpoint_path(&instance_directory(), endpoint.pid);
        if endpoint_file_matches(&path, endpoint) {
            if let Err(error) = std::fs::remove_file(path) {
                eprintln!("インスタンス情報を削除できませんでした: {error}");
            }
        }
    }
}

fn generate_token() -> io::Result<String> {
    let mut raw = [0u8; TOKEN_BYTES];
    getrandom::fill(&mut raw).map_err(|error| io::Error::other(error.to_string()))?;
    let mut hex = String::with_capacity(TOKEN_BYTES * 2);
    for byte in raw {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    Ok(hex)
}

fn is_valid_token(token: &str) -> bool {
    token.len() == TOKEN_BYTES * 2 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&a, &b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

fn server_auth_digest(token: &str, client_nonce: &[u8; CLIENT_NONCE_BYTES]) -> [u8; AUTH_DIGEST_BYTES] {
    let mut hasher = Sha256::new();
    hasher.update(b"wasabipad-server-v1:");
    hasher.update(token.as_bytes());
    hasher.update(client_nonce);
    hasher.finalize().into()
}

fn client_auth_digest(
    token: &str,
    client_nonce: &[u8; CLIENT_NONCE_BYTES],
    payload: &[u8],
) -> [u8; AUTH_DIGEST_BYTES] {
    let mut hasher = Sha256::new();
    hasher.update(b"wasabipad-client-v1:");
    hasher.update(token.as_bytes());
    hasher.update(client_nonce);
    hasher.update(payload);
    hasher.finalize().into()
}

fn remaining_timeout(deadline: Instant) -> io::Result<Duration> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "インスタンス通信が制限時間を超えました",
        ));
    }
    Ok(remaining)
}

fn read_exact_with_deadline(
    stream: &mut TcpStream,
    buf: &mut [u8],
    deadline: Instant,
) -> io::Result<()> {
    let mut filled = 0;
    while filled < buf.len() {
        stream.set_read_timeout(Some(remaining_timeout(deadline)?))?;
        match stream.read(&mut buf[filled..]) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "インスタンス通信が途中で切断されました",
                ));
            }
            Ok(n) => filled += n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn write_all_with_deadline(
    stream: &mut TcpStream,
    buf: &[u8],
    deadline: Instant,
) -> io::Result<()> {
    let mut written = 0;
    while written < buf.len() {
        stream.set_write_timeout(Some(remaining_timeout(deadline)?))?;
        match stream.write(&buf[written..]) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "インスタンス通信へ書き込めませんでした",
                ));
            }
            Ok(n) => written += n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn instance_directory() -> PathBuf {
    wasabipad_core::app_data_root()
        .map(|root| root.join(INSTANCE_DIR))
        .unwrap_or_else(|_| std::env::temp_dir().join("wasabipad-instances"))
}

fn instance_endpoint_path(directory: &Path, pid: u32) -> PathBuf {
    directory.join(format!("instance-{pid}.json"))
}

fn write_instance_endpoint(directory: &Path, endpoint: &InstanceEndpoint) -> io::Result<()> {
    std::fs::create_dir_all(directory)?;
    let text = serde_json::to_string(endpoint).map_err(io::Error::other)?;
    wasabipad_core::atomic_write(
        &instance_endpoint_path(directory, endpoint.pid),
        &[text.as_bytes()],
    )
}

fn endpoint_file_matches(path: &Path, endpoint: &InstanceEndpoint) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<InstanceEndpoint>(&text).ok())
        .is_some_and(|current| {
            current.port == endpoint.port
                && current.started_at == endpoint.started_at
                && current.token == endpoint.token
        })
}

fn read_instance_endpoints(directory: &Path) -> Vec<(PathBuf, InstanceEndpoint)> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut endpoints = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                return None;
            }
            let text = std::fs::read_to_string(&path).ok()?;
            let endpoint = serde_json::from_str::<InstanceEndpoint>(&text).ok()?;
            is_valid_token(&endpoint.token).then_some((path, endpoint))
        })
        .collect::<Vec<_>>();
    endpoints.sort_by(|(_, left), (_, right)| {
        right
            .started_at
            .cmp(&left.started_at)
            .then_with(|| right.pid.cmp(&left.pid))
    });
    endpoints
}

fn read_authenticated_window_request(
    stream: &mut TcpStream,
    token: &str,
    deadline: Instant,
) -> Option<WindowRequest> {
    if !is_valid_token(token) {
        return None;
    }
    let mut client_nonce = [0u8; CLIENT_NONCE_BYTES];
    read_exact_with_deadline(stream, &mut client_nonce, deadline).ok()?;
    let server_digest = server_auth_digest(token, &client_nonce);
    write_all_with_deadline(stream, &server_digest, deadline).ok()?;
    let _ = stream.flush();

    let mut len_bytes = [0u8; 4];
    read_exact_with_deadline(stream, &mut len_bytes, deadline).ok()?;
    let payload_len = u32::from_be_bytes(len_bytes) as usize;
    if payload_len == 0 || payload_len > MAX_WINDOW_REQUEST_BYTES {
        return None;
    }
    let mut payload = vec![0u8; payload_len];
    read_exact_with_deadline(stream, &mut payload, deadline).ok()?;
    let mut client_tag = [0u8; AUTH_DIGEST_BYTES];
    read_exact_with_deadline(stream, &mut client_tag, deadline).ok()?;
    let expected_tag = client_auth_digest(token, &client_nonce, &payload);
    if !constant_time_eq(&client_tag, &expected_tag) {
        return None;
    }
    serde_json::from_slice(&payload).ok()
}

fn handle_incoming_connection(
    mut stream: TcpStream,
    token: &str,
    pending: &Arc<Mutex<Vec<WindowRequest>>>,
) -> bool {
    let deadline = Instant::now() + WINDOW_REQUEST_DEADLINE;
    let Some(request) = read_authenticated_window_request(&mut stream, token, deadline) else {
        return false;
    };
    let queued = match pending.lock() {
        Ok(mut requests) => {
            if requests.len() >= MAX_PENDING_REQUESTS {
                false
            } else {
                requests.push(request);
                true
            }
        }
        Err(poisoned) => {
            eprintln!("外部起動要求のロックが壊れたため、待機要求を保持して復旧します");
            let mut requests = poisoned.into_inner();
            if requests.len() >= MAX_PENDING_REQUESTS {
                false
            } else {
                requests.push(request);
                true
            }
        }
    };
    if !queued {
        return false;
    }
    if write_all_with_deadline(&mut stream, ACK_BYTES, deadline).is_ok() {
        let _ = stream.flush();
    }
    true
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SendOutcome {
    Accepted,
    ConnectionRefused,
    Failed,
}

fn send_window_request(endpoint: &InstanceEndpoint, request: &WindowRequest) -> SendOutcome {
    if !is_valid_token(&endpoint.token) {
        return SendOutcome::Failed;
    }
    let address = SocketAddr::from(([127, 0, 0, 1], endpoint.port));
    let mut stream = match TcpStream::connect_timeout(&address, CONNECT_TIMEOUT) {
        Ok(stream) => stream,
        Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => {
            return SendOutcome::ConnectionRefused;
        }
        Err(_) => return SendOutcome::Failed,
    };
    let deadline = Instant::now() + WINDOW_REQUEST_DEADLINE;
    let mut client_nonce = [0u8; CLIENT_NONCE_BYTES];
    if getrandom::fill(&mut client_nonce).is_err() {
        return SendOutcome::Failed;
    }
    if write_all_with_deadline(&mut stream, &client_nonce, deadline).is_err() {
        return SendOutcome::Failed;
    }
    let _ = stream.flush();
    let mut server_digest = [0u8; AUTH_DIGEST_BYTES];
    if read_exact_with_deadline(&mut stream, &mut server_digest, deadline).is_err() {
        return SendOutcome::Failed;
    }
    let expected_server = server_auth_digest(&endpoint.token, &client_nonce);
    if !constant_time_eq(&server_digest, &expected_server) {
        // ポート再利用先の別サービスや偽サーバへファイルパスを送信する前に即時切断する。
        return SendOutcome::Failed;
    }
    let Ok(payload) = serde_json::to_vec(request) else {
        return SendOutcome::Failed;
    };
    if payload.is_empty() || payload.len() > MAX_WINDOW_REQUEST_BYTES {
        return SendOutcome::Failed;
    }
    let len_bytes = (payload.len() as u32).to_be_bytes();
    let client_tag = client_auth_digest(&endpoint.token, &client_nonce, &payload);
    if write_all_with_deadline(&mut stream, &len_bytes, deadline).is_err()
        || write_all_with_deadline(&mut stream, &payload, deadline).is_err()
        || write_all_with_deadline(&mut stream, &client_tag, deadline).is_err()
    {
        return SendOutcome::Failed;
    }
    let _ = stream.flush();
    let mut ack = [0u8; ACK_BYTES.len()];
    if read_exact_with_deadline(&mut stream, &mut ack, deadline).is_err() {
        return SendOutcome::Failed;
    }
    if ack == ACK_BYTES {
        SendOutcome::Accepted
    } else {
        SendOutcome::Failed
    }
}

#[cfg(target_os = "windows")]
fn is_process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid == 0 {
        return false;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut exit_code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut exit_code);
        let _ = CloseHandle(handle);
        ok != 0 && exit_code == STILL_ACTIVE as u32
    }
}

#[cfg(not(target_os = "windows"))]
fn is_process_alive(_pid: u32) -> bool {
    true
}

pub(crate) fn forward_to_latest_instance(request: &WindowRequest) -> bool {
    let directory = instance_directory();
    for (path, endpoint) in read_instance_endpoints(&directory) {
        match send_window_request(&endpoint, request) {
            SendOutcome::Accepted => return true,
            SendOutcome::ConnectionRefused => {
                if endpoint_file_matches(&path, &endpoint) {
                    let _ = std::fs::remove_file(&path);
                }
            }
            SendOutcome::Failed => {
                if !is_process_alive(endpoint.pid) && endpoint_file_matches(&path, &endpoint) {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }
    false
}

pub(crate) fn launch_new_instance(mut request: WindowRequest) -> Result<(), String> {
    request.secondary = true;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let json = serde_json::to_string(&request).map_err(|error| error.to_string())?;
    let mut command = Command::new(executable);
    command.args(["--wasabipad-window-request", &json]);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

pub(crate) fn parse_window_request(
    mut args: impl Iterator<Item = String>,
) -> Result<WindowRequest, String> {
    let Some(first) = args.next() else {
        return Ok(WindowRequest::default());
    };
    if first == "--wasabipad-window-request" {
        let json = args
            .next()
            .ok_or_else(|| "ウィンドウ要求がありません".to_string())?;
        return serde_json::from_str(&json).map_err(|error| error.to_string());
    }
    let goto = args.next().and_then(|arg| {
        let (line, col) = arg.strip_prefix('+')?.split_once(':')?;
        Some(PosC {
            line: line.parse().ok()?,
            col: col.parse().ok()?,
        })
    });
    Ok(WindowRequest {
        path: Some(first),
        goto,
        ..WindowRequest::default()
    })
}

pub(crate) fn initial_window_request() -> Result<WindowRequest, String> {
    parse_window_request(std::env::args().skip(1))
}

pub(crate) fn take_pending_window_requests(
    state: &tauri::State<'_, InstanceServer>,
) -> Vec<WindowRequest> {
    match state.pending.lock() {
        Ok(mut requests) => std::mem::take(&mut *requests),
        Err(poisoned) => {
            eprintln!("外部起動要求のロックが壊れたため、待機要求を保持して取り出します");
            std::mem::take(&mut *poisoned.into_inner())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        generate_token, handle_incoming_connection, read_authenticated_window_request,
        send_window_request, InstanceEndpoint, InstanceServer, SendOutcome, AUTH_DIGEST_BYTES,
        CLIENT_NONCE_BYTES, MAX_PENDING_REQUESTS, MAX_WINDOW_REQUEST_BYTES,
    };
    use crate::WindowRequest;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    // Feature: 外部ウィンドウ要求の入力上限
    // Scenario: 上限を超えるローカル要求を受信する
    // Given: 1 MiBを超える長さヘッダを送るTCP接続
    // When: 認証済みウィンドウ要求を読み取る
    // Then: ペイロード確保前に要求を破棄する
    #[test]
    fn rejects_window_requests_over_the_size_limit() {
        let token = generate_token().unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            stream.write_all(&[1u8; CLIENT_NONCE_BYTES]).unwrap();
            let mut server_digest = [0u8; AUTH_DIGEST_BYTES];
            stream.read_exact(&mut server_digest).unwrap();
            let oversized = (MAX_WINDOW_REQUEST_BYTES as u32) + 1;
            stream.write_all(&oversized.to_be_bytes()).unwrap();
        });
        let (mut server, _) = listener.accept().unwrap();

        assert!(read_authenticated_window_request(
            &mut server,
            &token,
            Instant::now() + Duration::from_secs(2)
        )
        .is_none());
        client.join().unwrap();
    }

    // Feature: ローカルインスタンス通信の相互認証とACK
    // Scenario: 正しいトークンで要求を転送する
    // Given: ランダムトークンを持つローカル受付サーバ
    // When: 一致するトークンのエンドポイントへ WindowRequest を送信する
    // Then: サーバが認証してキューへ積み、ACK により Accepted が返る
    #[test]
    fn authenticated_roundtrip_delivers_request_with_ack() {
        let token = generate_token().unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let pending = Arc::new(Mutex::new(Vec::new()));
        let server_pending = Arc::clone(&pending);
        let server_token = token.clone();
        let server_thread = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            assert!(handle_incoming_connection(stream, &server_token, &server_pending));
        });

        let endpoint = InstanceEndpoint {
            port,
            pid: std::process::id(),
            started_at: 1,
            token,
        };
        let request = WindowRequest {
            path: Some(r"C:\work\secret.txt".to_string()),
            ..WindowRequest::default()
        };
        assert_eq!(send_window_request(&endpoint, &request), SendOutcome::Accepted);
        server_thread.join().unwrap();
        let received = pending.lock().unwrap();
        assert_eq!(received.len(), 1);
        assert_eq!(received[0].path.as_deref(), Some(r"C:\work\secret.txt"));
    }

    // Feature: ローカルインスタンス通信の認証拒否とポート再利用防御
    // Scenario: 誤トークン送信やポート再利用先の別サービスへ接続する
    // Given: サーバ側と異なるトークン、またはランダム応答を返す偽サーバ
    // When: send_window_request を実行する
    // Then: 認証失敗し、偽サーバ側にはファイルパス JSON が一切送信されない
    #[test]
    fn rejects_wrong_token_and_never_leaks_path_to_reused_port() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let leaked = Arc::new(Mutex::new(Vec::<u8>::new()));
        let leaked_ref = Arc::clone(&leaked);
        let rogue_server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut nonce = [0u8; CLIENT_NONCE_BYTES];
            stream.read_exact(&mut nonce).unwrap();
            // 正規トークンを知らない別プロセスを模擬して誤った 32 バイトを返す
            stream.write_all(&[0xAAu8; AUTH_DIGEST_BYTES]).unwrap();
            let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
            let mut extra = Vec::new();
            let _ = stream.read_to_end(&mut extra);
            *leaked_ref.lock().unwrap() = extra;
        });

        let endpoint = InstanceEndpoint {
            port,
            pid: std::process::id(),
            started_at: 1,
            token: generate_token().unwrap(),
        };
        let request = WindowRequest {
            path: Some(r"C:\topsecret\private.md".to_string()),
            ..WindowRequest::default()
        };
        assert_eq!(send_window_request(&endpoint, &request), SendOutcome::Failed);
        rogue_server.join().unwrap();
        assert!(leaked.lock().unwrap().is_empty());
    }

    // Feature: ローカルインスタンス通信のキュー上限と総デッドライン
    // Scenario: 待機キューが上限に達した状態で新規要求が届く・遅い接続が総デッドラインを超える
    // Given: MAX_PENDING_REQUESTS 件で満杯の待機キューと、1バイトだけ送って止まる接続
    // When: handle_incoming_connection / read_authenticated_window_request を実行する
    // Then: キュー超過時は拒否され、遅延接続は総デッドラインで打ち切られる
    #[test]
    fn enforces_queue_cap_and_total_deadline() {
        let token = generate_token().unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let pending = Arc::new(Mutex::new(vec![WindowRequest::default(); MAX_PENDING_REQUESTS]));
        let server_pending = Arc::clone(&pending);
        let server_token = token.clone();
        let server_thread = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            assert!(!handle_incoming_connection(stream, &server_token, &server_pending));
        });
        let endpoint = InstanceEndpoint {
            port,
            pid: std::process::id(),
            started_at: 1,
            token: token.clone(),
        };
        assert_eq!(
            send_window_request(&endpoint, &WindowRequest::default()),
            SendOutcome::Failed
        );
        server_thread.join().unwrap();
        assert_eq!(pending.lock().unwrap().len(), MAX_PENDING_REQUESTS);

        // Slowloris: 1 バイトだけ送って保持しても総デッドラインで即終了する
        let slow_listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let slow_addr = slow_listener.local_addr().unwrap();
        let slow_client = thread::spawn(move || {
            let mut stream = TcpStream::connect(slow_addr).unwrap();
            let _ = stream.write_all(&[0u8; 1]);
            thread::sleep(Duration::from_millis(300));
        });
        let (mut server, _) = slow_listener.accept().unwrap();
        let started = Instant::now();
        assert!(read_authenticated_window_request(
            &mut server,
            &token,
            Instant::now() + Duration::from_millis(100)
        )
        .is_none());
        assert!(started.elapsed() < Duration::from_secs(1));
        slow_client.join().unwrap();

        // フォールバックの disabled() インスタンスは安全に終了できる
        let disabled = InstanceServer::disabled();
        disabled.remove_endpoint();
    }
}
