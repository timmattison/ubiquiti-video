import { z } from 'zod'
import { URLSearchParams } from 'url'
import axios, { type AxiosResponse } from 'axios'
import axiosRetry from 'axios-retry'
import * as https from 'https'
import * as fs from 'fs'
import { UbiquitiEnvironment } from './ubiquiti-environment.ts'
import { getPrismaClientOverSsh } from './prisma-client.ts'
import ffmpeg from 'fluent-ffmpeg'
import {
  add,
  differenceInMinutes,
  differenceInSeconds,
  format,
  formatDistanceStrict,
  isBefore,
} from 'date-fns'
import ora from 'ora'

export async function getFullCameras() {
  const prismaClientOverSsh = await getPrismaClientOverSsh()

  const cameras = await prismaClientOverSsh.prismaClient.cameras.findMany()

  await prismaClientOverSsh.prismaClient.$disconnect()
  prismaClientOverSsh.localServer.close()
  prismaClientOverSsh.ssh.dispose()

  return UbiquitiCamerasSchema.parse(cameras)
}

export async function getSimpleCameras() {
  return UbiquitiCamerasSchema.parse(await getFullCameras()).map((value) => ({
    id: value.id,
    name: value.name,
  }))
}

const UbiquitiCameraSchema = z.object({
  id: z.string().min(24).max(24),
  mac: z.string().min(12).max(12),
  host: z.string().ip(),
  connectionHost: z.string().ip(),
  type: z.string(),
  name: z.string(),
  channels: z.array(
    z.object({
      enabled: z.boolean(),
      isRtspEnabled: z.boolean(),
      width: z.number(),
      height: z.number(),
      fps: z.number(),
      bitrate: z.number(),
      minBitrate: z.number(),
      maxBitrate: z.number(),
    }),
  ),
  stats: z.object({
    rxBytes: z.number(),
    txBytes: z.number(),
    wifi: z.object({
      channel: z.any().optional(),
      frequency: z.any().optional(),
      linkSpeedMbps: z.any().optional(),
      signalQuality: z.number(),
      signalStrength: z.number(),
    }),
    battery: z.object({
      percentage: z.any().optional(),
      isCharging: z.boolean(),
    }),
    video: z.object({
      recordingStart: z.number().nullable(),
      recordingEnd: z.number().nullable(),
      recordingStartLQ: z.number().nullable(),
      recordingEndLQ: z.number().nullable(),
      timelapseStart: z.number().nullable(),
      timelapseEnd: z.number().nullable(),
      timelapseStartLQ: z.number().nullable(),
      timelapseEndLQ: z.number().nullable(),
    }),
  }),
})

const UbiquitiCamerasSchema = z.array(UbiquitiCameraSchema)

type UbiquitiCamerasType = z.infer<typeof UbiquitiCamerasSchema>

type Payload = Record<string, any>
type Cookies = Record<string, string>

async function postWithCookies(
  url: string,
  payload: Payload,
  cookies: Cookies = {},
): Promise<{
  responseText: string
  updatedCookies: Cookies
}> {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    Cookie: Object.entries(cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; '),
  }

  const body = new URLSearchParams(payload).toString()

  // Configure retries
  axiosRetry(axios, {
    retries: 3,
    // Retry on Network Errors & 4xx responses
    retryCondition: (error) => {
      return error.response == null || error.response.status >= 400
    },
  })

  const response: AxiosResponse = await axios.post(url, body, {
    headers,
    httpsAgent: new https.Agent({
      rejectUnauthorized: false,
    }),
    withCredentials: true,
  })

  const responseText = response.data

  const setCookieHeader = response.headers['set-cookie']
  const updatedCookies = { ...cookies }

  if (setCookieHeader !== undefined) {
    setCookieHeader.forEach((cookie: string) => {
      const [key, value] = cookie.split(';')[0].split('=')
      updatedCookies[key.trim()] = value.trim()
    })
  }

  return { responseText, updatedCookies }
}

function percent(input: number | undefined) {
  if (input === undefined) return 'Unknown'

  return input.toLocaleString(undefined, {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })
}

async function getBinaryDataWithCookies(
  url: string,
  cookies: Cookies = {},
  filename: string,
  logMessage: string,
): Promise<{
  updatedCookies: Cookies
}> {
  const headers = {
    Cookie: Object.entries(cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; '),
  }

  const writer = fs.createWriteStream(filename)

  const spinner = ora(`Waiting to download... ${logMessage}`).start()

  const response: AxiosResponse = await axios.get(url, {
    headers,
    httpsAgent: new https.Agent({
      rejectUnauthorized: false,
    }),
    withCredentials: true,
    responseType: 'stream',
    onDownloadProgress: (progressEvent) => {
      spinner.color = 'yellow'
      spinner.text = `Downloading... ${percent(
        progressEvent.progress,
      )} ${logMessage}`
    },
  })

  response.data.pipe(writer)

  const setCookieHeader = response.headers['set-cookie']
  const updatedCookies = { ...cookies }

  if (setCookieHeader != null) {
    setCookieHeader.forEach((cookie: string) => {
      const [key, value] = cookie.split(';')[0].split('=')
      updatedCookies[key.trim()] = value.trim()
    })
  }

  return await new Promise<{ updatedCookies: Cookies }>((resolve, reject) => {
    writer.on('finish', () => {
      spinner.color = 'green'
      spinner.text = `Download complete of ${logMessage}`
      spinner.stop()
      resolve({ updatedCookies })
    })
    writer.on('error', (err) => {
      spinner.fail('Error writing to the file')
      reject(err)
    })
    response.data.on('error', (err: Error) => {
      spinner.fail('Error reading the response from the server')
      reject(err)
    })
  })
}

const auth: Payload = {
  username: UbiquitiEnvironment.UbiquitiUsername,
  password: UbiquitiEnvironment.UbiquitiPassword,
}

export interface StartAndEndStrings {
  start: string
  end: string
}

export interface StartAndEndEpochs {
  start: number
  end: number
}

async function getCookies() {
  const cookies: Cookies = {}

  // const { responseText: loginResult, updatedCookies: loginCookies } =
  const { updatedCookies: loginCookies } = await postWithCookies(
    'https://192.168.0.1:443/api/auth/login',
    auth,
    cookies,
  )

  return loginCookies
}

const OutputFileSchema = z.object({
  camera: UbiquitiCameraSchema.pick({ id: true, name: true }),
  start: z.date(),
  end: z.date(),
  filename: z.string(),
})

type OutputFileType = z.infer<typeof OutputFileSchema>

async function convertToMkv(inputPath: string, outputPath: string) {
  return await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions('-c', 'copy') // This copies the existing audio and video streams without re-encoding
      .output(outputPath)
      .on('start', function () {
        // console.log('Conversion started')
      })
      .on('progress', function (progress) {
        // console.log(`Progress: ${progress.percent}% done`)
      })
      .on('end', function () {
        // console.log('Conversion ended successfully')
        resolve(true)
      })
      .on('error', function (err) {
        console.log('Conversion error: ', err)
        reject(err)
      })
      .run()
  })
}

function formatDate(date: Date) {
  return format(date, 'yyyy-MM-dd hh:mm:ss aa')
}

export async function getVideo(
  cameras: UbiquitiCamerasType,
  start: Date,
  end: Date,
  mp4: boolean,
) {
  const outputFiles: OutputFileType[] = []

  let currentStart = start

  const maxMinuteDiff = {
    minutes: 60,
  }

  while (isBefore(currentStart, end)) {
    const diffInMinutes = differenceInMinutes(end, currentStart)
    let currentEnd: Date

    if (diffInMinutes > maxMinuteDiff.minutes) {
      currentEnd = add(currentStart, maxMinuteDiff)
    } else {
      currentEnd = end
    }

    for (const camera of cameras) {
      const url = `https://192.168.0.1:443/proxy/protect/api/video/export?camera=${
        camera.id
      }&start=${currentStart.getTime()}&end=${currentEnd.getTime()}`

      const formattedStart = formatDate(currentStart)
      const formattedEnd = formatDate(currentEnd)

      const logMessage = `${formattedStart} -> ${formattedEnd} - ${camera.name}`

      const baseFilename = `${formattedStart}_${formattedEnd}_${camera.name}`
      const mp4Filename = `${baseFilename}.mp4`
      const mkvFilename = `${baseFilename}.mkv`

      currentStart = add(currentStart, maxMinuteDiff)

      if (fs.existsSync(mp4Filename)) {
        if (fs.statSync(mp4Filename).size === 0) {
          fs.unlinkSync(mp4Filename)
        } else {
          console.log(
            `${mp4Filename} already exists and is not empty, refusing to overwrite it`,
          )
          continue
        }
      }

      const downloadStart = Date.now()

      // Get cookies each time so we don't time out our login on requests for large videos
      const cookies = await getCookies()

      await getBinaryDataWithCookies(url, cookies, mp4Filename, logMessage)

      const downloadEnd = Date.now()
      const diffInSeconds = differenceInSeconds(downloadEnd, downloadStart)
      const mp4FileStats = fs.statSync(mp4Filename)
      const throughput = mp4FileStats.size / diffInSeconds

      let throughputString: string

      if (throughput > 1000000) {
        throughputString = `${Math.round(throughput / 1000000)} MB`
      } else {
        throughputString = `${Math.round(throughput)} B`
      }

      // Must log something here or the user will only see the live download
      //   updates but won't know how many files were downloaded already
      console.log(
        `Downloaded ${logMessage} in ${formatDistanceStrict(
          downloadEnd,
          downloadStart,
        )} [${throughputString}/s]`,
      )

      if (!mp4) {
        await convertToMkv(mp4Filename, mkvFilename)
        fs.unlinkSync(mp4Filename)
      }

      outputFiles.push(
        OutputFileSchema.parse({
          camera,
          start,
          end,
          filename: mp4 ? mp4Filename : mkvFilename,
        }),
      )
    }
  }

  return outputFiles
}
