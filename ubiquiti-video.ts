#!/usr/bin/env -S npx ts-node-esm

import { fileURLToPath } from 'url'
import { command, flag, number, option, run, string, subcommands } from 'cmd-ts'
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import { getFullCameras, getSimpleCameras, getVideo } from './ubiquiti.ts'
import { add, startOfDay } from 'date-fns'
import ffmpeg, { type FfprobeData } from 'fluent-ffmpeg'
import pLimit from 'p-limit'

export function scriptDirname() {
  return path.dirname(fileURLToPath(import.meta.url))
}

const ArgumentsSchema = z.object({
  cameraName: z.string(),
  start: z.date(),
  end: z.date(),
  mp4: z.boolean().default(false),
})

type ArgumentsType = z.infer<typeof ArgumentsSchema>

function includes(haystack: string, needle: string) {
  return haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase())
}

async function listCameras() {
  console.log(JSON.stringify(await getSimpleCameras(), null, 2))
}

async function main(args: ArgumentsType) {
  const cameras = await getFullCameras()

  const filteredCameras = cameras.filter(
    (value) =>
      includes(value.name, args.cameraName) ||
      includes(value.id, args.cameraName),
  )

  if (filteredCameras.length === 0) {
    throw new Error('No cameras matched')
  } else if (filteredCameras.length > 1) {
    throw new Error(
      `Multiple cameras matched ${JSON.stringify(
        filteredCameras.map((value) => value.name),
      )}`,
    )
  }

  console.log(
    JSON.stringify(
      await getVideo(filteredCameras, args.start, args.end, args.mp4),
      null,
      2,
    ),
  )
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
    cameraName: option({
      long: 'camera-name',
      short: 'c',
      type: string,
      description: 'name of the camera',
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
    cameraName: option({
      long: 'camera-name',
      short: 'c',
      type: string,
      description: 'name of the camera',
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

async function getAudioSampleRate(inputFile: string) {
  return await new Promise<number>((resolve, reject) => {
    ffmpeg(inputFile).ffprobe((err: Error | null, metadata: FfprobeData) => {
      if (err != null) {
        reject(err)
        return
      }

      const audioStreams = metadata.streams.filter(
        (stream) => stream.codec_type === 'audio',
      )

      if (audioStreams.length === 0) {
        reject(new Error('No audio streams found'))
        return
      }

      if (audioStreams.length > 1) {
        reject(new Error('More than one audio stream found, can not continue'))
        return
      }

      const sampleRate = audioStreams[0].sample_rate

      if (sampleRate === undefined) {
        reject(new Error('Audio sample rate is undefined, can not continue'))
        return
      }

      resolve(sampleRate)
    })
  })
}

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

const listCamerasCommand = command({
  name: 'list-cameras',
  args: {},
  handler: async () => {
    await listCameras()
  },
})

const commandLineParser = subcommands({
  name: packageInfo.name,
  description: packageInfo.description,
  version: packageInfo.version,
  cmds: {
    list: listCamerasCommand,
    fetch: fetchCommand,
    'fetch-day': fetchDayCommand,
    'extract-audio': extractAudioCommand,
  },
})

void run(commandLineParser, process.argv.slice(2)).finally()
