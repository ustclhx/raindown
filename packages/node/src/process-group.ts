/**
 * 向进程组发 SIGKILL（审查第四轮：harness 的任何退出路径都结束其进程组，worker 留在后台的子进程不比 harness 活得更久）。
 * 组已不存在（ESRCH）或无权（EPERM）时忽略。调用 setsid 的子进程会离开进程组，由节点的 mds 已知良好快照兜底（design Risks）。
 */
export function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined || pid <= 0) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ESRCH' && code !== 'EPERM') throw err
  }
}
