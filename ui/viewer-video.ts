export function createVideoPreview(name: string, source: string) {
  const wrapper = document.createElement("div");
  wrapper.className = "viewer-video-wrap";
  const video = document.createElement("video");
  video.className = "viewer-video";
  video.controls = true;
  video.preload = "metadata";
  video.playsInline = true;
  video.setAttribute("aria-label", name);
  const error = document.createElement("p");
  error.className = "viewer-error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  const onError = () => {
    // MEDIA_ERR_SRC_NOT_SUPPORTED can also mean an unreadable or damaged source.
    error.textContent = video.error?.code === 2 ? "動画を読み込めません" : "動画を再生できません";
    if (video.error?.code === 4) {
      error.textContent += "。この環境で非対応の形式、ファイルの破損、読み取り失敗などが考えられます。";
    }
    error.hidden = false;
    video.hidden = true;
  };
  video.addEventListener("error", onError);
  video.src = source;
  wrapper.append(video, error);
  const stop = (reset = false) => {
    video.pause();
    if (reset) video.currentTime = 0;
  };
  const dispose = () => {
    video.removeEventListener("error", onError);
    stop();
    video.removeAttribute("src");
    video.load();
  };
  return { wrapper, video, stop, dispose };
}
