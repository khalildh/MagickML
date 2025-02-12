import {
  CompletionBody,
  CreateEventArgs,
  EngineContext,
  GetEventArgs,
  MagickWorkerInputs,
} from '@magickml/core'
import { prisma } from '@magickml/prisma'
import vm2 from 'vm2'
import { CustomError } from '../../utils/CustomError'

import { queryGoogleSearch } from '../utils/queryGoogle'
import { searchWikipedia } from '../wikipedia/helpers'

import { database } from '@magickml/database'
import { makeCompletion } from '../../utils/MakeCompletionRequest'
import { runSpell } from '../utils/runSpell'
import {
  API_ROOT_URL,
  API_URL,
  APP_SEARCH_SERVER_URL,
  OPENAI_API_KEY,
} from '@magickml/server-config'

import run_python from '../../../../../packages/core/src/ProcessPython'


const getEvents = async ({
  type,
  agent,
  speaker,
  client,
  channel,
  maxCount,
  max_time_diff,
}: GetEventArgs) => {
  const event = await database.getEvents({
    type,
    agent,
    speaker,
    client,
    channel,
    maxCount,
    max_time_diff,
  })

  if (!event) return null

  return event
}

const createEvent = async (args: CreateEventArgs) => {
  const { type, agent, speaker, client, channel, text, sender } = args
  return await database.createEvent({
    type,
    agent,
    speaker,
    sender,
    client,
    channel,
    text,
  })
}

export const buildMagickInterface = (
  initialGameState: Record<string, unknown>,
  overrides: Record<string, Function> = {}
): EngineContext => {
  // eslint-disable-next-line functional/no-let
  let gameState = { ...initialGameState }
  const env = {
    API_ROOT_URL,
    API_URL,
    APP_SEARCH_SERVER_URL,
  }

  return {
    env,
    runSpell: async (flattenedInputs, spellId, state) => {
      const { outputs } = await runSpell({
        state,
        spellName: spellId,
        inputs: flattenedInputs,
      })

      console.log('*************************RUNSPELL OUTPUTS', outputs)

      return outputs
    },
    completion: async (body: CompletionBody) => {
      // check body for API key, otherwise use the environment
      const openaiApiKey = body.apiKey ? body.apiKey : OPENAI_API_KEY

      if (!openaiApiKey) throw new Error('No API key provided')

      const { success, choice } = await makeCompletion(body.modelName, {
        prompt: body.prompt.trim(),
        temperature: body.temperature,
        max_tokens: body.maxTokens,
        top_p: body.topP,
        frequency_penalty: body.frequencyPenalty,
        presence_penalty: body.presencePenalty,
        stop: body.stop,
        apiKey: openaiApiKey,
      })

      return { success, choice }
    },
    getSpell: async spellId => {
      const spell = await prisma.spells.findUnique({ where: { name: spellId } })

      return spell
    },
    queryGoogle: async query => {
      const response = await queryGoogleSearch(query)
      return response
    },
    processCode: async (
      code: unknown,
      inputs: MagickWorkerInputs,
      data: Record<string, any>,
      state: Record<string, any>,
      language: string='javascript'
    ) => {
      if (language=='javascript'){
        const { VM } = vm2
        const vm = new VM()

        // Inputs are flattened before we inject them for a better code experience
        const flattenInputs = Object.entries(inputs).reduce(
          (acc, [key, value]: [string, any]) => {
            acc[key] = value[0]
            return acc
          },
          {} as Record<string, any>
        )

        // Freeze the variables we are injecting into the VM
        vm.freeze(data, 'data')
        vm.freeze(flattenInputs, 'input')
        vm.protect(state, 'state')

        // run the code
        const codeToRun = `"use strict"; function runFn(input,data,state){ return (${code})(input,data,state)}; runFn(input,data,state);`

        try {
          const codeResult = vm.run(codeToRun)
          console.log('CODE RESULT', codeResult)
          return codeResult
        } catch (err) {
          console.log({ err })
          throw new CustomError(
            'server-error',
            'Error in spell runner: processCode component: ' + code
          )
        }
      } else if (language == 'python') {
        console.log(code)
        const codeResult = await run_python(code);
        console.log(codeResult);
      }
    },
    setCurrentGameState: state => {
      gameState = state
    },
    getCurrentGameState: () => {
      return gameState
    },
    updateCurrentGameState: (update: Record<string, unknown>) => {
      const newState = {
        ...gameState,
        ...update,
      }

      gameState = newState
    },
    // IMPLEMENT THESE INTERFACES FOR THE SERVERbuildMagickInterface
    getEvent: async (args: GetEventArgs) => {
      return await getEvents(args)
    },
    storeEvent: async (args: CreateEventArgs) => {
      return await createEvent(args)
    },
    getWikipediaSummary: async (keyword: string) => {
      let out = null
      try {
        out = (await searchWikipedia(keyword as string)) as any
      } catch (err) {
        throw new Error('Error getting wikipedia summary')
      }

      console.log('WIKIPEDIA SEARCH', out)

      return out
    },
  }
}
