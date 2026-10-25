let source;
export function connectEvents(onEvent) {
  source?.close();
  source = new EventSource("/api/events");
  source.onopen = () => {
    document.querySelector("#connection").textContent = "● Live connection";
  };
  source.onerror = () => {
    document.querySelector("#connection").textContent = "○ Reconnecting…";
  };
  source.onmessage = () => onEvent();
  source.addEventListener("refresh", onEvent);
  return () => source.close();
}
