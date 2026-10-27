/** Authenticated WS edge; credentials and socket lifetime follow the active identity. */
export function connectNotifications(options: {
  url: string;
  current: () => boolean;
  message: (event: Record<string, unknown>) => void;
  socket?: (url: string) => WebSocket;
}): () => void {
  let disposed = false,
    attempts = 0;
  let socket: WebSocket | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    if (disposed || !options.current()) return;
    socket = (options.socket ?? ((url) => new WebSocket(url)))(options.url);
    socket.onopen = () => {
      attempts = 0;
    };
    socket.onmessage = (e) => {
      if (disposed || !options.current()) return;
      try {
        const message = JSON.parse(String(e.data)) as Record<string, unknown>;
        if (message.type === 'ping') socket?.send(JSON.stringify({ type: 'pong' }));
        else options.message(message);
      } catch {
        /* invalid server event */
      }
    };
    socket.onclose = (event) => {
      if (disposed || !options.current() || [4001, 4002, 4003].includes(event.code)) return;
      timer = setTimeout(connect, Math.min(30000, 1000 * 2 ** attempts++));
    };
    socket.onerror = () => socket?.close();
  };
  connect();
  return () => {
    disposed = true;
    clearTimeout(timer);
    socket?.close();
  };
}
