import { App, ExpressReceiver } from '@slack/bolt';
import 'dotenv/config';
import db from './knex.js';

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: {
    commands: '/splack-opt-in',
    events: '/slack/events',
  },
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

app.event('message', async ({ event, client, logger }) => {
  if (!event || event.subtype || !event.user) {
    return;
  }

  try {
    const optedInUser = await db('users')
      .select('user_id')
      .where({ user_id: event.user })
      .first();

    if (!optedInUser) {
      return;
    }

    await client.chat.postMessage({
      channel: event.channel,
      text: `Hi <@${event.user}> I saw your message and you are opted in!`,
      thread_ts: event.ts,
    });
  } catch (error) {
    logger.error('Failed handling message event', error);
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
      text: `You have been opted in as <@${userId}>.`,
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

(async () => {
  await app.start(process.env.PORT || 3000);

  app.logger.info('⚡️ Bolt app is running!');
})();