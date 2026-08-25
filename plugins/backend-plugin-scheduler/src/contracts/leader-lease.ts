/** 进程级单例租约：多实例部署下保证调度循环只在一个进程内运行。 */
export interface SchedulerLeaderLease {
  acquire(): Promise<boolean>;
  release(): Promise<void>;
}
