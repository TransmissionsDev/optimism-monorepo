import * as fs from 'fs'
import { subtask } from 'hardhat/config'
import {
  TASK_COMPILE_SOLIDITY_RUN_SOLCJS,
  TASK_COMPILE_SOLIDITY_RUN_SOLC,
} from 'hardhat/builtin-tasks/task-names'

subtask(
  TASK_COMPILE_SOLIDITY_RUN_SOLCJS,
  async (
    { input, solcJsPath }: { input: any, solcJsPath: string },
    { config },
    runSuper
  ) => {
    if (fs.existsSync((config as any).solc.path)) {
      solcJsPath = (config as any).solc.path
    }

    return runSuper({ input, solcJsPath })
  }
)

subtask(
  TASK_COMPILE_SOLIDITY_RUN_SOLC,
  async (
    { input, solcPath }: { input: any, solcPath: string },
    { config, run },
    runSuper
  ) => {
    if (fs.existsSync((config as any).solc.path)) {
      return run(TASK_COMPILE_SOLIDITY_RUN_SOLCJS, {
        input,
        solcJsPath: (config as any).solc.path
      })
    } else {
      return runSuper({ input, solcPath })
    }
  }
)
