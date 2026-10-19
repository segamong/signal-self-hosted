type NativeMessage = Record<string, any>;
type ServerEvent = {type:string;[key:string]:unknown};
const listeners = new Set<(message:NativeMessage)=>void>();
let currentBridge: typeof window.signalAndroidBridge;
let sequence = 0;

// Calls, HTTP replies and chat events share the origin-scoped native listener.
// Native transport also gives Android 5/6 the current server CA roots without
// accepting invalid TLS certificates in WebView.
function connectBridge() {
  const bridge = window.signalAndroidBridge;
  if (bridge && bridge !== currentBridge) {
    currentBridge = bridge;
    bridge.onmessage = event => {
      if (typeof event.data !== 'string' || event.data.length > 2_100_000) return;
      try {
        const data = JSON.parse(event.data);
        if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.type !== 'string') return;
        for (const receive of [...listeners]) receive(data);
      } catch { /* Ignore malformed or unsupported native messages. */ }
    };
  }
  return bridge;
}

export function subscribeAndroidMessage(receive:(message:NativeMessage)=>void) {
  connectBridge();
  listeners.add(receive);
  return () => { listeners.delete(receive); };
}

export function androidCommand(message:Record<string,unknown>) {
  connectBridge()?.postMessage(JSON.stringify(message));
}

export function androidApi(path:string, body?:unknown):Promise<{status:number;data:any}> {
  if (!window.signalAndroidBridge) return Promise.reject(new Error('Подключение приложения недоступно.'));
  return new Promise((resolve,reject) => {
    const requestId = `api:${++sequence}`;
    const unsubscribe = subscribeAndroidMessage(message => {
      if (message.type !== 'apiResponse' || message.requestId !== requestId) return;
      cleanup();
      if (!Number.isInteger(message.status) || message.status < 100 || message.status > 599) {
        reject(new Error('Не удалось связаться с сервером. Проверьте интернет.'));
      } else resolve({status:message.status,data:message.data});
    });
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Сервер не ответил. Проверьте интернет и повторите попытку.')); }, 45_000);
    const cleanup = () => { clearTimeout(timeout); unsubscribe(); };
    try { androidCommand({type:'requestApi',requestId,path,...(body === undefined ? {} : {body})}); }
    catch { cleanup(); reject(new Error('Не удалось отправить запрос к серверу.')); }
  });
}

export function subscribeAndroidServerEvents(receive:(event:ServerEvent)=>void) {
  const unsubscribe = subscribeAndroidMessage(message => {
    if (message.type !== 'serverEvent' || !message.event || typeof message.event.type !== 'string') return;
    const event = message.event as ServerEvent;
    if (event.type === 'connection') receive({...event,type:'desktop-connection'});
    else if (event.type === 'session-expired') receive({type:'desktop-connection',connected:false,code:4001});
    else receive(event);
  });
  androidCommand({type:'subscribeEvents'});
  return () => { androidCommand({type:'unsubscribeEvents'}); unsubscribe(); };
}
