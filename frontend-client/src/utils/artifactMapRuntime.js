let activeController = null;

export function bindArtifactMapRuntime(controller) {
  if (!controller || typeof controller !== 'object') throw new TypeError('地图控制器不能为空');
  activeController = controller;
  return () => {
    if (activeController === controller) activeController = null;
  };
}

export function getArtifactMapRuntime() {
  return activeController;
}

export async function callArtifactMapRuntime(method, input, context) {
  const controller = getArtifactMapRuntime();
  if (!controller) throw new Error('当前页面没有可用的地图工作台');
  const action = controller[method];
  if (typeof action !== 'function') throw new Error(`地图工作台不支持操作: ${method}`);
  return action(input || {}, context || {});
}
