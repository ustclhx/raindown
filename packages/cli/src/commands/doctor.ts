import {
  type DoctorOptions,
  formatDoctorReport,
  raindownHomeSource,
  resolveRaindownHome,
  runDoctor,
} from '@raindown/core'
import { nodeHubClientFromHome } from '@raindown/node'
import { defineCommand } from '../command.ts'

export const createDoctorCommand = (options: DoctorOptions = {}) =>
  defineCommand({
    name: 'doctor',
    summary: '检查 raindown-home、git 仓库、密钥扫描钩子、外部工具与节点的隔离自检结果',
    run: () => {
      const home = resolveRaindownHome(process.env)
      return runDoctor(home, raindownHomeSource(process.env), {
        // 隔离自检结果由节点上报到中枢，doctor 经中枢读取汇总；中枢不可用时只给提示。
        isolationNodes: async () => {
          const client = await nodeHubClientFromHome(home)
          return client.ok ? client.data.listNodes() : client
        },
        ...options,
      })
    },
    human: formatDoctorReport,
  })

export const doctorCommand = createDoctorCommand()
