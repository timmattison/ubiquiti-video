#!/usr/bin/env -S npx ts-node-esm

import { fileURLToPath } from 'url'
import {
  command,
  flag,
  number,
  option,
  optional,
  run,
  string,
  subcommands,
} from 'cmd-ts'
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import { add, startOfDay } from 'date-fns'
import ffmpeg, { type FfprobeData } from 'fluent-ffmpeg'
import pLimit from 'p-limit'
import { UbiquitiEnvironment } from './ubiquiti-environment.ts'
import ora from 'ora'
import {
  fetchVideo,
  type Status,
  StatusType,
} from '@timmattison/uprotect-fetch'

export function scriptDirname() {
  return path.dirname(fileURLToPath(import.meta.url))
}

const ArgumentsSchema = z.object({
  cameraId: z.string(),
  cameraName: z.string().optional(),
  start: z.date(),
  end: z.date(),
  mp4: z.boolean().default(false),
})

type ArgumentsType = z.infer<typeof ArgumentsSchema>

async function main(args: ArgumentsType) {
  const cameras = [{ id: args.cameraId, name: args.cameraName }]
  const auth = {
    username: UbiquitiEnvironment.UbiquitiUsername,
    password: UbiquitiEnvironment.UbiquitiPassword,
  }

  const spinner = ora().start()

  const result = await fetchVideo({
    ipAddress: UbiquitiEnvironment.UbiquitiIp,
    auth,
    cameras,
    start: args.start,
    end: args.end,
    mp4: args.mp4,
    statusCallback: (status: Status) => {
      switch (status.type) {
        case StatusType.Waiting:
          spinner.text = 'Waiting to start downloading...'
          break
        case StatusType.Downloading:
          if (status.progressPercent !== undefined) {
            spinner.text = `Downloading: ${String(status.progressPercent)}`
          } else {
            spinner.text = 'Downloading...'
          }
          break
        case StatusType.DownloadThroughput:
          if (status.throughputString !== undefined) {
            spinner.text = `Download throughput: ${String(
              status.throughputString,
            )}/s`
          }
          break
        case StatusType.Converting:
          spinner.text = `Converting...`
          break
        case StatusType.Done:
          if (status.filename !== undefined) {
            spinner.succeed(`Done [${String(status.filename)}]`)
          } else {
            spinner.succeed('Done')
          }
          spinner.stop()
          break
        case StatusType.AllDone:
          spinner.stop()
          break
        case StatusType.Error:
          throw status.error
      }
    },
  })
  JSON.stringify(result, null, 2)
}

const NameVersionDescriptionSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string(),
})

const packageInfo = NameVersionDescriptionSchema.parse(
  JSON.parse(
    fs.readFileSync(path.resolve(scriptDirname(), './package.json'), 'utf8'),
  ),
)

const StartOfDaySchema = z
  .string()
  .regex(/^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}$/)
  .transform((data) => {
    const splitInput = data.split('-')
    const year = Number(splitInput[0])
    const month = Number(splitInput[1])
    const day = Number(splitInput[2])
    return startOfDay(new Date(year, month - 1, day))
  })

const fetchDayCommand = command({
  name: 'fetch-day',
  args: {
    cameraId: option({
      long: 'camera-id',
      short: 'i',
      type: string,
      description: 'ID of the camera',
    }),
    cameraName: option({
      long: 'camera-name',
      short: 'n',
      type: optional(string),
      description: 'name of the camera (for naming output files)',
    }),
    date: option({
      long: 'date',
      short: 's',
      type: string,
      description: 'date (formatted as YYYY-MM-DD)',
    }),
    mp4: flag({
      long: 'mp4',
      short: 'm',
      description: 'keep as mp4 (otherwise convert to mkv for compatibility)',
      defaultValue: () => false,
    }),
  },
  handler: (args) => {
    const start = StartOfDaySchema.parse(args.date)
    const end = add(start, { hours: 24 })
    void main(
      ArgumentsSchema.parse({
        ...args,
        start,
        end,
      }),
    ).finally()
  },
})

const fetchCommand = command({
  name: 'fetch',
  args: {
    cameraId: option({
      long: 'camera-id',
      short: 'i',
      type: string,
      description: 'ID of the camera',
    }),
    cameraName: option({
      long: 'camera-name',
      short: 'n',
      type: optional(string),
      description: 'name of the camera (for naming output files)',
    }),
    start: option({
      long: 'start',
      short: 's',
      type: string,
      description:
        'start time (formatted as ISO 8601 - e.g. "2011-10-05T14:48:00.000Z")',
    }),
    end: option({
      long: 'end',
      short: 'e',
      type: string,
      description:
        'end time (formatted as ISO 8601 - e.g. "2011-10-05T14:49:00.000Z")',
    }),
    mp4: flag({
      long: 'mp4',
      short: 'm',
      description: 'keep as mp4 (otherwise convert to mkv for compatibility)',
      defaultValue: () => false,
    }),
  },
  handler: (args) => {
    void main(
      ArgumentsSchema.parse({
        ...args,
        start: new Date(args.start),
        end: new Date(args.end),
      }),
    ).finally()
  },
})

const defaultThreads = 10
const extractAudioCommand = command({
  name: 'extract-audio',
  args: {
    inputFile: option({
      long: 'input-file',
      short: 'i',
      type: string,
      description: 'the input file',
    }),
    chunkDuration: option({
      long: 'chunk-duration',
      short: 'd',
      type: number,
      description: 'the duration of the chunks of audio extracted (in seconds)',
    }),
    threads: option({
      long: 'threads',
      short: 't',
      type: number,
      description: `the number of concurrent threads to use to process the audio (default: ${defaultThreads})`,
      defaultValue: () => defaultThreads,
    }),
  },
  handler: async (args) => {
    const chunkDuration = args.chunkDuration
    const limit = pLimit(args.threads)

    const durationInSeconds = await getInputDuration(args.inputFile)
    const numberOfChunks = durationInSeconds - chunkDuration

    try {
      const promises: Array<Promise<string>> = []
      for (let loop = 0; loop < numberOfChunks; loop++) {
        promises.push(
          limit(
            async () => await extractAudio(args.inputFile, loop, chunkDuration),
          ),
        )
      }
      const result = await Promise.all(promises)
      console.log(result)
    } catch (error) {
      console.log('Processing finished with error:', error)
    }
  },
})

async function getInputDuration(inputFile: string) {
  return await new Promise<number>((resolve, reject) => {
    ffmpeg(inputFile).ffprobe((err: Error | null, metadata: FfprobeData) => {
      if (err != null) {
        reject(err)
        return
      }

      if (metadata.format.duration === undefined) {
        reject(
          new Error(`The duration of ${inputFile} could not be determined`),
        )
        return
      }

      resolve(metadata.format.duration)
    })
  })
}

async function extractAudio(
  inputFile: string,
  startTime: number,
  chunkDuration: number,
) {
  const outputFormat = 'wav'
  const startMinute = Math.floor(startTime / 60)
  const startSecond = Math.floor(startTime % 60)
  const startString = `${String(startMinute).padStart(2, '0')}m-${String(
    startSecond,
  ).padStart(2, '0')}s`
  const outputFile = `${inputFile}-audio-${startString}.${outputFormat}`

  return await new Promise<string>((resolve, reject) => {
    ffmpeg(inputFile)
      .setStartTime(startTime)
      .duration(chunkDuration)
      // .audioCodec('pcm_s16le')
      .toFormat(outputFormat)
      .on('end', () => {
        console.log(`Segment ${startTime} processed`)
        resolve(outputFile)
      })
      .on('error', (err) => {
        console.error(err.message)
        reject(err)
      })
      // Save audio file named by its order.
      .save(outputFile)
  })
}

const commandLineParser = subcommands({
  name: packageInfo.name,
  description: packageInfo.description,
  version: packageInfo.version,
  cmds: {
    fetch: fetchCommand,
    'fetch-day': fetchDayCommand,
    'extract-audio': extractAudioCommand,
  },
})

void run(commandLineParser, process.argv.slice(2)).finally()
