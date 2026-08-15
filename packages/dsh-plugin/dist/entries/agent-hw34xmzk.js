// ../plugin/src/shared/rpc-notifications.ts
var queue = [];
var nextNotificationId = 1;
var sinks = new Set;
function registerNotificationSink(sink) {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}
function notificationMatchesSink(notification, sink) {
  if (notification.sessionId === undefined)
    return true;
  if (sink.sessionId !== undefined)
    return notification.sessionId === sink.sessionId;
  return sink.protocol !== 2;
}
function pushNotification(type, payload, sessionId) {
  const notification = { id: nextNotificationId++, type, payload, sessionId };
  queue.push(notification);
  for (const sink of sinks) {
    if (!notificationMatchesSink(notification, sink))
      continue;
    try {
      sink.send(notification);
    } catch {}
  }
  if (queue.length > 100) {
    const reservedIds = new Set;
    const reservedScopes = new Set;
    for (let i = queue.length - 1;i >= 0 && reservedScopes.size < 25; i -= 1) {
      const candidate = queue[i];
      const scope = candidate.sessionId ?? "\x00global";
      if (reservedScopes.has(scope))
        continue;
      reservedScopes.add(scope);
      reservedIds.add(candidate.id);
    }
    const evictionIndex = queue.findIndex((candidate) => !reservedIds.has(candidate.id));
    queue.splice(evictionIndex >= 0 ? evictionIndex : 0, 1);
  }
}
function acknowledgeNotifications(ids) {
  const acknowledged = new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0));
  if (acknowledged.size === 0)
    return;
  queue = queue.filter((notification) => !acknowledged.has(notification.id));
}
function __resetNotificationStateForTests() {
  queue = [];
  nextNotificationId = 1;
  sinks.clear();
}
function cursor(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
function drainNotifications(lastReceivedId = 0, sessionId, options = {}) {
  const sessionCursor = cursor(lastReceivedId);
  if (options.globalOnly) {
    queue = queue.filter((notification) => notification.sessionId !== undefined || notification.id > sessionCursor);
    return queue.filter((notification) => notification.sessionId === undefined && notification.id > sessionCursor);
  }
  if (options.sessionOnly) {
    if (sessionId === undefined)
      return [];
    queue = queue.filter((notification) => notification.sessionId !== sessionId || notification.id > sessionCursor);
    return queue.filter((notification) => notification.sessionId === sessionId && notification.id > sessionCursor);
  }
  if (sessionId !== undefined && options.globalLastReceivedId !== undefined) {
    const globalCursor = cursor(options.globalLastReceivedId);
    queue = queue.filter((notification) => {
      if (notification.sessionId === undefined)
        return notification.id > globalCursor;
      if (notification.sessionId === sessionId)
        return notification.id > sessionCursor;
      return true;
    });
    return queue.filter((notification) => {
      if (notification.sessionId === undefined)
        return notification.id > globalCursor;
      return notification.sessionId === sessionId && notification.id > sessionCursor;
    });
  }
  const matchesClient = (notification) => sessionId === undefined || notification.sessionId === undefined || notification.sessionId === sessionId;
  if (sessionCursor > 0) {
    queue = queue.filter((notification) => !(notification.id <= sessionCursor && matchesClient(notification)));
  }
  return queue.filter((notification) => notification.id > sessionCursor && matchesClient(notification));
}
function isTuiConnected(sessionId) {
  if (sinks.size === 0)
    return false;
  if (sessionId === undefined)
    return true;
  for (const sink of sinks) {
    if (sink.sessionId === sessionId)
      return true;
    if (sink.sessionId === undefined && sink.protocol !== 2)
      return true;
  }
  return false;
}

export { registerNotificationSink, pushNotification, acknowledgeNotifications, __resetNotificationStateForTests, drainNotifications, isTuiConnected };
