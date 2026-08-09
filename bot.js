import { App, ExpressReceiver } from '@slack/bolt';
import 'dotenv/config';
import db from './knex.js';
import { readFile } from 'fs/promises';

const NON_OPTED_IN_ALLOWED_CHANNEL = 'C0BNS7VMW1H';
const GALAXY_FETCH_ATTEMPTS = 10;
const GALAXY_NAMES_FILE = new URL('./galaxy_names.txt', import.meta.url);
let GALAXY_NAMES = null;

async function loadGalaxyNames() {
  if (GALAXY_NAMES) return GALAXY_NAMES;
  const content = await readFile(GALAXY_NAMES_FILE, 'utf8');
  GALAXY_NAMES = content
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!GALAXY_NAMES.length) throw new Error('No galaxy names found in galaxy_names.txt');
  return GALAXY_NAMES;
}

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: {
    commands: ['/splack-opt-in', '/my-planets', '/splack-leaderboard'],
    events: '/slack/events',
  },
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

async function getChannelName(client, channelId) {
  try {
    const result = await client.conversations.info({ channel: channelId });
    return result.channel?.name || channelId;
  } catch (error) {
    return channelId;
  }
}

async function fetchRandomGalaxyName() {
  const names = await loadGalaxyNames();
  const idx = Math.floor(Math.random() * names.length);
  return names[idx];
}

function extractText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node === 'object') {
    if (typeof node.text === 'string') return node.text;
    if (typeof node.content === 'string') return node.content;
    if (node.content) return extractText(node.content);
    if (node.parts) return extractText(node.parts);
    if (node.message) return extractText(node.message);
    if (node.output) return extractText(node.output);
    return Object.values(node).map(extractText).join('');
  }
  return '';
}

async function get_planet_name(galaxyName) {
  const apiKey = process.env.HACKCLUB_AI_API_KEY;
  if (!apiKey) throw new Error('Missing HACKCLUB_AI_API_KEY in environment');

  const endpoint = process.env.HACKCLUB_AI_API_URL || 'https://ai.hackclub.com/proxy/v1/responses';

  const body = {
    model: 'qwen/qwen3-32b',
    input: `You are a robot that returns creative, evocative planet names. Return me a single word name for a planet. Return ONLY the name, no explanations or thinking AT ALL. /no_think`,
    max_output_tokens: 20,
    temperature: 1.5,
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {  
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Hack Club AI request failed: ${res.status} ${text}`);
  }

  const data = await res.json();

  const outputMessages = Array.isArray(data?.output) ? data.output : [];
  const assistantMessage = outputMessages.find(
    (item) => item?.type === 'message' && item?.role === 'assistant' && item?.status === 'completed'
  );

  let raw = '';
  if (assistantMessage?.content) {
    const content = assistantMessage.content;
    if (typeof content === 'string') {
      raw = content;
    } else if (Array.isArray(content)) {
      raw = content
        .map((part) => (part?.type === 'output_text' ? part.text : extractText(part)))
        .join('');
    } else {
      raw = extractText(content);
    }
  } else {
    raw = extractText(data?.output ?? data);
  }

  raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const nameCandidateRegex = /^[^\s'"“”]+(?:-[^\s'"“”]+)*$/;

  let candidate = null;
  for (const line of lines) {
    if (/thinking process/i.test(line)) continue;
    if (nameCandidateRegex.test(line)) {
      candidate = line;
      break;
    }
  }

  if (!candidate) {
    const words = raw.match(/[A-Za-z][A-Za-z'-]*/g);
    if (words && words.length) candidate = words[words.length - 1];
  }

  if (!candidate && lines.length) candidate = lines[0];
  if (!candidate) throw new Error('Unexpected response format from Hack Club AI');

  candidate = candidate.replace(/^['"“”]+|['"“”]+$/g, '').trim();
  if (!candidate) throw new Error('Unexpected response format from Hack Club AI');
  return candidate;
}

async function getUniqueGalaxyName() {
  const usedGalaxies = new Set((await db('channels').select('galaxy')).map((row) => row.galaxy));

  for (let attempt = 0; attempt < GALAXY_FETCH_ATTEMPTS; attempt += 1) {
    const galaxy = await fetchRandomGalaxyName();
    if (!usedGalaxies.has(galaxy)) {
      return galaxy;
    }
  }

  throw new Error('Unable to generate a unique galaxy name after multiple attempts');
}

async function resolvePlanetMessage(messageTs, channel, status, userId) {
  if (!messageTs) return { won: true };

  try {
    await db('planet_resolutions').insert({ message_ts: messageTs, channel, status, resolved_by: userId });
    return { won: true };
  } catch (error) {
    if (error?.code === '23505') {
      const existing = await db('planet_resolutions').select('status', 'resolved_by').where({ message_ts: messageTs }).first();
      return { won: false, existing };
    }
    throw error;
  }
}

async function ensureChannelRecord(client, channelId, logger) {
  const channelName = await getChannelName(client, channelId);
  const existingChannel = await db('channels').select('id', 'galaxy').where({ name: channelName }).first();

  if (existingChannel) {
    return { created: false, galaxy: existingChannel.galaxy };
  }

  for (let attempt = 0; attempt < GALAXY_FETCH_ATTEMPTS; attempt += 1) {
    const galaxy = await getUniqueGalaxyName();

    try {
      // return the created galaxy so caller can announce it
      await db('channels').insert({ name: channelName, galaxy });
      return { created: true, galaxy };
    } catch (error) {
      if (error?.code === '23505') {
        // unique constraint violation - another process likely created it concurrently
        const existing = await db('channels').select('galaxy').where({ name: channelName }).first();
        if (existing) return { created: false, galaxy: existing.galaxy };
        continue;
      }

      logger.error('Failed to insert new channel record', error);
      throw error;
    }
  }

  throw new Error(`Could not create a unique channel record for ${channelName}`);
}

app.event('message', async ({ event, client, logger }) => {
  if (!event || event.subtype || !event.user) {
    return;
  }


  try {
    const optedInUser = await db('users')
      .select('user_id')
      .where({ user_id: event.user })
      .first();

    if (!optedInUser && event.channel !== NON_OPTED_IN_ALLOWED_CHANNEL) {
      return;
    }

    console.log("Opted in user message detected")

    const ensureResult = await ensureChannelRecord(client, event.channel, logger);

    if (ensureResult && ensureResult.created) {
      await client.chat.postMessage({
        channel: event.channel,
        text: `New galaxy discovered! Planets found in this channel will be in the ${ensureResult.galaxy}`,
        thread_ts: event.ts,
      });
    }
    try {
      if (event.user === 'U07UV4R2G4T' || Math.random() < 0.20) {
        console.log("Planet discovered!")
        const planet = await get_planet_name(ensureResult.galaxy);

        const claimPayload = JSON.stringify({
          planet,
          galaxy: ensureResult.galaxy,
          thread_ts: event.ts,
        });

        const blocks = [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: ':ringed_planet: - yay! you found a new planet!',
              emoji: true,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `you found ${planet} in ${ensureResult.galaxy}! would you like to claim this planet?`,
            },
            accessory: {
              type: 'image',
              image_url: 'https://files.slack.com/files-pri/T09V59WQY1E-F0BNY58J4CS/dizzy.png?pub_secret=e3730c9f64',
              alt_text: 'dizzy planet',
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'claim it!',
                  emoji: true,
                },
                value: claimPayload,
                action_id: 'actionId-0',
              },
            ],
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'explode the planet',
                  emoji: true,
                },
                value: claimPayload,
                action_id: 'actionId-1',
              },
            ],
          },
        ];

        if (!optedInUser) {
          blocks.push({
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: 'You are not opted in - Run /splack-opt-in to use this bot in other channels',
              },
            ],
          });
        }

        await client.chat.postMessage({
          channel: event.channel,
          text: `You found ${planet} in ${ensureResult.galaxy}!`,
          blocks,
          thread_ts: event.ts,
        });
      }
    } catch (error) {
      logger.error('Failed handling planet discovery', error);
    }
  } catch (error) {
    logger.error('Failed handling message event', error);
  }
});

const CLAIM_MODAL_CALLBACK_ID = 'claim_planet_modal';
const CLAIM_NAME_BLOCK_ID = 'planet_name_block';
const CLAIM_NAME_ACTION_ID = 'planet_name_input';

app.action('actionId-0', async ({ ack, body, client, logger }) => {
  await ack();

  try {
    const { planet, galaxy, thread_ts } = JSON.parse(body.actions[0].value);
    const userId = body.user.id;
    const channelId = body.channel.id;

    const optedInUser = await db('users').select('user_id').where({ user_id: userId }).first();

    if (!optedInUser) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: 'You need to run `/splack-opt-in` before you can claim planets.',
      });
      return;
    }

    const messageTs = body.message?.ts;
    if (messageTs) {
      const existing = await db('planet_resolutions').select('status').where({ message_ts: messageTs }).first();
      if (existing) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: `Too slow! ${planet} was already ${existing.status} by someone else.`,
        });
        return;
      }
    }

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: CLAIM_MODAL_CALLBACK_ID,
        private_metadata: JSON.stringify({
          planet,
          galaxy,
          channel: channelId,
          thread_ts,
          message_ts: body.message?.ts,
        }),
        title: { type: 'plain_text', text: 'Claim your planet', emoji: true },
        submit: { type: 'plain_text', text: 'Claim it!', emoji: true },
        close: { type: 'plain_text', text: 'Cancel', emoji: true },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `you found *${planet}* in *${galaxy}*! name it whatever you like, or leave the field blank to keep *${planet}*.`,
            },
          },
          {
            type: 'input',
            block_id: CLAIM_NAME_BLOCK_ID,
            optional: true,
            label: { type: 'plain_text', text: 'Planet name', emoji: true },
            hint: { type: 'plain_text', text: `Leave blank to keep ${planet}`, emoji: true },
            element: {
              type: 'plain_text_input',
              action_id: CLAIM_NAME_ACTION_ID,
              max_length: 100,
              placeholder: { type: 'plain_text', text: planet, emoji: true },
            },
          },
        ],
      },
    });
  } catch (error) {
    logger.error('Failed to open claim planet modal', error);
  }
});

app.action('actionId-1', async ({ ack, body, client, logger }) => {
  await ack();

  try {
    const { planet, galaxy } = JSON.parse(body.actions[0].value);
    const userId = body.user.id;
    const channelId = body.channel.id;
    const messageTs = body.message.ts;

    const resolution = await resolvePlanetMessage(messageTs, channelId, 'exploded', userId);
    if (!resolution.won) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: `Too slow! ${planet} was already ${resolution.existing.status} by someone else.`,
      });
      return;
    }

    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: `<@${userId}> exploded ${planet} in ${galaxy}!`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:boom: <@${userId}> exploded *${planet}* in *${galaxy}*! it's gone forever now,,,`,
          },
          accessory: {
            type: 'image',
            image_url: 'https://emoji.slack-edge.com/T09V59WQY1E/explodes/ce543444b61209cf.png',
            alt_text: 'exploding planet',
          },
        },
      ],
    });
  } catch (error) {
    logger.error('Failed handling planet explosion', error);
  }
});

app.view(CLAIM_MODAL_CALLBACK_ID, async ({ ack, body, view, client, logger }) => {
  const metadata = JSON.parse(view.private_metadata);
  const submittedName = view.state.values[CLAIM_NAME_BLOCK_ID]?.[CLAIM_NAME_ACTION_ID]?.value;
  const name = (submittedName || '').trim() || metadata.planet;

  if (name.length > 100) {
    await ack({
      response_action: 'errors',
      errors: { [CLAIM_NAME_BLOCK_ID]: 'Planet names must be 100 characters or fewer.' },
    });
    return;
  }

  await ack();

  const userId = body.user.id;

  try {
    const resolution = await resolvePlanetMessage(metadata.message_ts, metadata.channel, 'claimed', userId);
    if (!resolution.won) {
      await client.chat.postEphemeral({
        channel: metadata.channel,
        user: userId,
        text: `Too slow! ${metadata.planet} was already ${resolution.existing.status} by someone else.`,
      });
      return;
    }

    await db('planets').insert({ name, user: userId, galaxy: metadata.galaxy });

    if (metadata.message_ts) {
      // drop the buttons so the planet can't be claimed twice
      await client.chat.update({
        channel: metadata.channel,
        ts: metadata.message_ts,
        text: `<@${userId}> claimed ${name} in ${metadata.galaxy}! Check it out at https://splack.ivie.codes`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:ringed_planet: <@${userId}> claimed *${name}* in *${metadata.galaxy}*! Check it out at https://splack.ivie.codes`,
            },
          },
        ],
      });
    } else {
      await client.chat.postMessage({
        channel: metadata.channel,
        thread_ts: metadata.thread_ts,
        text: `<@${userId}> claimed ${name} in ${metadata.galaxy}!`,
      });
    }
  } catch (error) {
    logger.error('Failed to claim planet', error);
    await client.chat.postEphemeral({
      channel: metadata.channel,
      user: userId,
      text: 'Something went wrong while claiming that planet. Please try again.',
    });
  }
});

app.command('/splack-opt-in', async ({ ack, payload, respond, logger }) => {
  await ack();

  const userId = payload.user_id;
  const username = payload.user_name;

  if (!userId || !username) {
    logger.error('Missing Slack user info for /opt-in command', { payload });
    await respond({
      text: 'Unable to register you right now. Please try again later.',
      response_type: 'ephemeral',
    });
    return;
  }

  try {
    await db('users')
      .insert({ user_id: userId, username })
      .onConflict('user_id')
      .merge({ username });

    await respond({
      text: `You have been opted in as <@${userId}>. Add the bot to your channels to start discovering planets.`,
      response_type: 'ephemeral',
    });
  } catch (error) {
    logger.error('Failed to opt in user', error);
    await respond({
      text: 'There was an error saving your opt-in. Please try again later.',
      response_type: 'ephemeral',
    });
  }
});

app.command('/my-planets', async ({ ack, payload, respond, logger }) => {
  await ack();

  const userId = payload.user_id;

  try {
    const planets = await db('planets')
      .select('name', 'galaxy')
      .where({ user: userId })
      .orderBy('galaxy');

    if (!planets.length) {
      await respond({
        text: "You haven't claimed any planets yet. Keep chatting to discover some!",
        response_type: 'ephemeral',
      });
      return;
    }

    const lines = planets.map((p) => `:ringed_planet: *${p.name}* — ${p.galaxy}`);

    await respond({
      response_type: 'ephemeral',
      text: `Your planets (${planets.length})`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: `:ringed_planet: Your planets (${planets.length})`, emoji: true },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: lines.join('\n') },
        },
      ],
    });
  } catch (error) {
    logger.error('Failed to fetch planets', error);
    await respond({
      text: 'Something went wrong fetching your planets. Please try again later.',
      response_type: 'ephemeral',
    });
  }
});

const LEADERBOARD_MEDALS = [':first_place_medal:', ':second_place_medal:', ':third_place_medal:'];
const LEADERBOARD_LIMIT = 10;

app.command('/splack-leaderboard', async ({ ack, respond, logger, client }) => {
  await ack();

  try {
    const userRows = await db('planets')
      .join('users', 'planets.user', 'users.user_id')
      .select('users.user_id')
      .count('planets.id as planet_count')
      .groupBy('users.user_id')
      .orderBy('planet_count', 'desc')
      .limit(LEADERBOARD_LIMIT);

    const channelRows = await db('planets')
      .join('channels', 'planets.galaxy', 'channels.galaxy')
      .select('channels.name as channel_name')
      .count('planets.id as planet_count')
      .groupBy('channels.name')
      .orderBy('planet_count', 'desc')
      .limit(LEADERBOARD_LIMIT);

    const channelNames = await Promise.all(
      channelRows.map((row) => getChannelName(client, row.channel_name))
    );

    const userLines = userRows.length
      ? userRows.map((row, i) => `${LEADERBOARD_MEDALS[i] || `${i + 1}.`} <@${row.user_id}> — ${row.planet_count} planets`)
      : ['No planets claimed yet.'];

    const channelLines = channelRows.length
      ? channelRows.map((row, i) => `${LEADERBOARD_MEDALS[i] || `${i + 1}.`} #${channelNames[i]} — ${row.planet_count} planets`)
      : ['No planets claimed yet.'];

    await respond({
      response_type: 'ephemeral',
      text: 'Splack Leaderboard',
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: ':trophy: Splack Leaderboard', emoji: true },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Top Explorers*\n${userLines.join('\n')}` },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Top Galaxies*\n${channelLines.join('\n')}` },
        },
      ],
    });
  } catch (error) {
    logger.error('Failed to build leaderboard', error);
    await respond({
      text: 'Something went wrong building the leaderboard. Please try again later.',
      response_type: 'ephemeral',
    });
  }
});

(async () => {
  await app.start(process.env.PORT || 3000);

  app.logger.info('⚡️ Bolt app is running!');
})();