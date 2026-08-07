let activeController = null;

export function bindFileMapRuntime(controller) {
  if (!controller || typeof controller !== 'object') throw new TypeError('地图控制器不能为空');
  activeController = controller;
  return () => { if (activeController === controller) activeController = null; };
}

export function getFileMapRuntime() { return activeController; }

export async function callFileMapRuntime(method, input, context) {
  const controller = getFileMapRuntime();
  if (!controller) throw new Error('当前页面没有可用的地图工作台');
  const action = controller[method];
  if (typeof action !== 'function') throw new Error(`地图工作台不支持操作: ${method}`);
  return action(input || {}, context || {});
}
