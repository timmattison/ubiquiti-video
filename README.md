# ubiquiti-video

This is a command-line tool to pull video from Ubiquiti's UniFi protect into MP4 or MKV files.

NOTE: In this document we assume your DVR's IP address is `192.168.1.1`. If it is different you'll need to adjust the
commands and `.env` file accordingly.

## How to use this script

If you've never run this script before just run `pnpm install` and it should install everything you need.

To fetch video from a camera you'll need the camera's ID. If you don't have your camera IDs you can get them with a
tool like [ubiquiti-db](https://github.com/timmattison/ubiquiti-db).

```bash
./ubiquiti-video.ts list
```

And it will print out a list of your cameras as a JSON array.

### Fetching video

Fetching video from a camera can be done like this:

```bash
./ubiquiti-video.ts fetch -i "63eeeeeeefffffffeeeaab68" -s 2023-07-22T15:40:00 -e 2023-07-22T15:42:00
```

This will fetch two minutes of video for the camera with the ID `63eeeeeeefffffffeeeaab68` from July 22nd, 2023 at 15:
40:00 to 15:42:00 and convert the video to `.mkv` format.

The file will be called `2023-07-22_03:40:00_PM_2023-07-22_03:42:00_PM_63eeeeeeefffffffeeeaab68.mkv`.

If you want the video to remain in `.mp4` format just add the `-m` flag to the command.

## Setup

To set this script up you'll need to:

- Have ffmpeg installed (if you want `.mkv` format videos)
- Configure the `.env` file values
- Install the dependencies

### Fill in the .env file

This repository contains a file called `.env.example` with some sample values in it. You'll need to copy/move this file
to `.env` and fill in your own values. The example file looks like this:

```text
export UbiquitiUsername=USERNAME
export UbiquitiPassword=PASSWORD
export UbiquitiIp=192.168.1.1
```

Fill in your Ubiquiti credentials in the username and password fields. For some people this will be their ui.com
credentials.
For other people with specific local credentials you'll need to use those instead.

Change the IP address to the IP address of your DVR, if necessary.

### Install the dependencies

This script has only been tested with `pnpm`. `npm` and `yarn` might work but you're on your own.

```bash
pnpm install
```
