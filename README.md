# ubiquiti-video

This is a command-line tool to pull video from Ubiquiti's UniFi protect into MP4 or MKV files.

NOTE: In this document we assume your DVR's IP address is `192.168.1.1`. If it is different you'll need to adjust the commands and `.env` file accordingly.

## How to use this script

If you've never run this script before run the steps in the `Setup` section below.

Once that's complete you can run the command to list cameras like this:

```bash
./ubiquiti-video.ts list
```

And it will print out a list of your cameras as a JSON array.

### Fetching video

Fetching video from a camera can be done like this:

```bash
ubiquiti-video fetch -c "cameraname" -s 2023-07-22T15:40:00 -e 2023-07-22T15:42:00
```

This will do a case-insensitive search for a camera with the string `cameraname` in its name, extract two minutes of video from it
from July 22nd, 2023 at 15:40:00 to 15:42:00 and convert the video to `.mkv` format.

If you want the video to remain in `.mp4` format just add the `-m` flag to the command.

If multiple cameras match the requested name the command will fail.

## Setup

To set this script up you'll need to:

- Have ffmpeg installed (if you want `.mkv` format videos)
- Set up the SSH connection so that you can connect without a password (public key authentication)
- Configure the `.env` file values
- Install the dependencies
- Pull the DB schema
- Generate the Prisma code

### Set up the SSH connection

For this script to work properly you'll need to set up public key authentication to your Ubiquiti DVR. You can do this
in the Ubiquiti Network UI under Settings -> System and `Device Authentication` at the bottom.

Check `Device SSH Authentication` and add your SSH key.

If you need help read [Ubiquiti's instructions on how to do this](https://help.ui.com/hc/en-us/articles/235247068-UniFi-Adding-SSH-Keys-to-UniFi-Devices).

### Fill in the .env file

This repository contains a file called `.env.example` with some sample values in it. You'll need to copy/move this file
to `.env` and fill in your own values. The example file looks like this:

```text
export UbiquitiUsername=USERNAME
export UbiquitiPassword=PASSWORD
export UbiquitiSshUsername=root
export UbiquitiIp=192.168.1.1
```

Fill in your Ubiquiti credentials in the username and password fields. For some people this will be their ui.com credentials.
For other people with specific local credentials you'll need to use those instead.

Generally you'll leave the SSH username as `root`.

Change the IP address to the IP address of your DVR, if necessary.

### Install the dependencies

This script has only been tested with `pnpm`. `npm` and `yarn` might work but you're on your own.

```bash
pnpm install
```

### Pull the DB schema and generate the Prisma code

You'll need to get the database schema from your DVR for the script to run. If you receive errors about missing columns like `phy_rate` run this to get the latest schema.

1. In one terminal set up a tunnel to the DVR with port forwarding to PostgreSQL:

```
ssh root@192.168.1.1 -L5433:localhost:5433
```

2. In this directory in another terminal:

```
pnpm install
pnpm dlx prisma db pull
pnpm dlx prisma generate
```

NOTE: If you receive an error like this:

```text
assertion failed [block != nullptr]: BasicBlock requested for unrecognized address
```

Try the command again until it works. This appears to be an issue with M1 systems. This can happen many, many times in a row. Eventually it works.

## Generate the Prisma code

To generate the TypeScript client from the schema do the following:

1. In one terminal set up a tunnel to the DVR with port forwarding to PostgreSQL:

```
ssh root@192.168.1.1 -L5433:localhost:5433
```

2. In this directory in another terminal:

```
pnpm install
pnpm dlx prisma generate
```
