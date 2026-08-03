use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
}

pub(crate) struct InstanceServer {
    listener: Mutex<Option<TcpListener>>,
    endpoint: Option<InstanceEndpoint>,
    pub(crate) pending: Arc<Mutex<Vec<WindowRequest>>>,
}

const INSTANCE_DIR: &str = "wasabipad-instances";

impl InstanceServer {
    pub(crate) fn new() -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).ok();
        let endpoint = listener
            .as_ref()
            .and_then(|listener| listener.local_addr().ok())
            .map(|address| InstanceEndpoint {
                port: address.port(),
                pid: std::process::id(),
                started_at: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos(),
            });
        if let Some(endpoint) = &endpoint {
            write_instance_endpoint(endpoint);
        }
        Self {
            listener: Mutex::new(listener),
            endpoint,
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
        let Some(listener) = listener else { return };
        let pending = Arc::clone(&self.pending);
        let app = app.clone();
        std::thread::spawn(move || {
            for incoming in listener.incoming() {
                let Ok(stream) = incoming else { continue };
                let Some(request) = read_window_request(stream) else {
                    continue;
                };
                match pending.lock() {
                    Ok(mut requests) => requests.push(request),
                    Err(poisoned) => {
                        eprintln!("外部起動要求のロックが壊れたため、待機要求を保持して復旧します");
                        poisoned.into_inner().push(request);
                    }
                }
                let _ = app.emit(EVENT_EXTERNAL_WINDOW_REQUEST, ());
            }
        });
    }

    pub(crate) fn remove_endpoint(&self) {
        let Some(endpoint) = &self.endpoint else {
            return;
        };
        let path = instance_endpoint_path(endpoint.pid);
        let matches = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<InstanceEndpoint>(&text).ok())
            .is_some_and(|current| {
                current.port == endpoint.port && current.started_at == endpoint.started_at
            });
        if matches {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn instance_directory() -> PathBuf {
    std::env::temp_dir().join(INSTANCE_DIR)
}

fn instance_endpoint_path(pid: u32) -> PathBuf {
    instance_directory().join(format!("instance-{pid}.json"))
}

fn write_instance_endpoint(endpoint: &InstanceEndpoint) {
    let directory = instance_directory();
    if std::fs::create_dir_all(&directory).is_err() {
        return;
    }
    if let Ok(text) = serde_json::to_string(endpoint) {
        let _ = std::fs::write(instance_endpoint_path(endpoint.pid), text);
    }
}

fn read_instance_endpoints() -> Vec<(PathBuf, InstanceEndpoint)> {
    let Ok(entries) = std::fs::read_dir(instance_directory()) else {
        return Vec::new();
    };
    let mut endpoints = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let text = std::fs::read_to_string(&path).ok()?;
            Some((path, serde_json::from_str::<InstanceEndpoint>(&text).ok()?))
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

fn read_window_request(mut stream: TcpStream) -> Option<WindowRequest> {
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn send_window_request(endpoint: &InstanceEndpoint, request: &WindowRequest) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], endpoint.port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(250)) else {
        return false;
    };
    let Ok(bytes) = serde_json::to_vec(request) else {
        return false;
    };
    if stream.write_all(&bytes).is_err() {
        return false;
    }
    let _ = stream.shutdown(Shutdown::Write);
    true
}

pub(crate) fn forward_to_latest_instance(request: &WindowRequest) -> bool {
    for (path, endpoint) in read_instance_endpoints() {
        if send_window_request(&endpoint, request) {
            return true;
        }
        let _ = std::fs::remove_file(path);
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
