// アプリ内モーダルの土台。Tauri の webview では window.alert/confirm/prompt が
// 使えないため自前で重ねる。重ね方 (overlay の生成・Escape・背景クリック・後始末) は
// ここだけが持ち、中身と「閉じたときに何を返すか」は呼び出し側が決める。
//
// 画面ごとに書いていたときは、背景クリックで閉じるものと閉じないものが混ざっていた。
// 逃げ道の作法は画面ごとに変わってよいものではない。

export interface ModalPorts {
  // Escape と背景クリック。どちらも同じ「やめる」として扱う
  onCancel: () => void;
  // Enter。無い画面では素通しする (入力欄が自前で Enter を使うため)
  onAccept?: () => void;
}

export interface Modal {
  box: HTMLElement; // 中身を足す場所
  close: () => void; // 重ねたものを片付ける (結果の通知は呼び出し側の仕事)
}

export function openModal(ports: ModalPorts, boxClass = ""): Modal {
  const overlay = document.createElement("div");
  overlay.className = "pf-overlay";
  const box = document.createElement("div");
  box.className = boxClass ? `pf-box ${boxClass}` : "pf-box";
  overlay.append(box);

  const close = () => {
    overlay.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      ports.onCancel();
    } else if (e.key === "Enter" && ports.onAccept) {
      e.preventDefault();
      ports.onAccept();
    }
  };
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) ports.onCancel();
  });
  window.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
  return { box, close };
}
