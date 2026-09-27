# Testing through a staging deployment

A staging deployment is a second Seam with its own Discord bot, test guild,
checkout and database. Agents working in your real deployment drive it the
way a person would: they post messages, click buttons and run slash commands.
That exercises the real Discord path before a change is merged.

## Pieces

- **Staging bot:** a separate Discord application. Don't reuse the production
  token. Two processes on one token both handle every interaction, fight over
  slash-command registration, and overwrite each other's presence.
- **Test guild:** only the staging and tester bots are members, so staging
  can't touch real threads.
- **Tester bot:** a third application that plays the person. It never
  connects to the gateway; the driving deployment holds its token and uses it
  only to post and read over REST. Invite it to the test guild only, with
  View Channels, Send Messages, Send Messages in Threads, Create Public
  Threads, Embed Links, Attach Files, Read Message History, Add Reactions and
  Send Voice Messages. Turn on the Message Content intent (it reads replies)
  and turn off Public Bot.

## Configuration

**Staging `.env`** (the deployment under test):
- `DISCORD_ALLOWED_USER_IDS`: include the tester bot's user id.
- `DISCORD_ALLOWED_BOT_IDS`: the tester bot's user id. Seam normally ignores
  every bot; a listed bot's messages are handled exactly like a person's
  (admission, restart catch-up, rebuild history). Seam always ignores its own
  messages.
- `SEAM_CONFIG_ADMIN_USER_IDS`: optionally the tester bot, so it can exercise
  admin-only config.
- `SEAM_TEST_DRIVER_KEY`: a random shared secret.
- `SEAM_TEST_DRIVER_ACTOR_ID`: the tester bot's user id.

  Together these two turn on `POST /test/interaction` on the health port.
  Never set them on a deployment people use.

**Driving `.env`** (the deployment your agents run in):
- `SEAM_TEST_BOT_TOKEN`: the tester bot's token.
- `SEAM_TEST_BOT_CHANNEL_IDS`: the staging test channels. The tools refuse
  anything outside these channels and their threads.
- `SEAM_TEST_DRIVER_URL`: staging's health-port base URL, reachable from the
  driving host.
- `SEAM_TEST_DRIVER_KEY`: the same secret as staging's.

## Tools (seam-MCP)

- **`tester_post({ channel, text, threadName? })`:** posts as the tester bot.
  `threadName` starts a new thread in a test channel first, as a person would.
  Returns the thread and message ids.
- **`tester_read({ channel, after?, limit? })`:** reads messages oldest first,
  including staging's replies and status-card text.
- **`tester_interact({ kind, channel, ... })`:** `kind` is `slash`, `button`,
  `select` or `modal`. A stand-in interaction goes into the staging client's
  own event stream, so collectors waiting on a message see it the way they'd
  see a real click. It acts as `SEAM_TEST_DRIVER_ACTOR_ID`, so permission
  checks are real. Get message and custom ids from `tester_read`.

## How close to Discord it is

The stand-in keeps Discord's interaction rules:
- **3-second deadline:** a handler that hasn't acknowledged within 3 s gets
  "unknown interaction" (10062).
- **One acknowledgement:** a second one fails with 40060.
- **Follow-up window:** follow-ups stop working after 15 minutes.
- **Command checking:** slash options are checked against the registered
  command definitions, so a call real Discord would reject fails the same way.
- **Forms:** a form a handler opens is recorded; a second `modal` call submits it.

What it can't reproduce:
- **Private replies:** a bot can't show another bot an ephemeral message, so
  these are posted in the thread with a visible marker.
- **The Discord client:** anything about how the client renders a message
  still needs a person to look.
