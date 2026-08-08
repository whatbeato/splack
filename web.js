import express from 'express';
import nunjucks from 'nunjucks';
import 'dotenv/config';
import db from './knex.js';

const app = express();

nunjucks.configure('views', {
  autoescape: true,
  express: app,
});

app.use('/static', express.static('public'));

const userInfoCache = new Map();
const channelNameCache = new Map();

async function getChannelName(channelId) {
  if (channelNameCache.has(channelId)) return channelNameCache.get(channelId);

  try {
    const res = await fetch(`https://slack.com/api/conversations.info?channel=${channelId}`, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    });
    const data = await res.json();
    const name = data?.ok && data.channel?.name ? data.channel.name : channelId;
    channelNameCache.set(channelId, name);
    return name;
  } catch (error) {
    console.error(`Failed to fetch channel name for ${channelId}`, error);
    channelNameCache.set(channelId, channelId);
    return channelId;
  }
}

const MAX_PLANETS_PER_GALAXY = 8;

function galaxyGroupLabel(index) {
  let label = '';
  let n = index;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

function splitLargeGalaxies(galaxies) {
  const result = [];

  for (const galaxy of galaxies) {
    if (galaxy.planets.length <= MAX_PLANETS_PER_GALAXY) {
      result.push(galaxy);
      continue;
    }

    const groupCount = Math.ceil(galaxy.planets.length / MAX_PLANETS_PER_GALAXY);
    const groupSize = Math.ceil(galaxy.planets.length / groupCount);
    for (let i = 0; i < groupCount; i++) {
      const slice = galaxy.planets.slice(i * groupSize, (i + 1) * groupSize);
      if (slice.length === 0) continue;
      result.push({ ...galaxy, name: `${galaxy.name} ${galaxyGroupLabel(i)}`, planets: slice });
    }
  }

  return result;
}

async function getUserInfo(userId, fallbackName) {
  const fallback = { displayName: fallbackName, imageUrl: null };
  if (!userId) return fallback;
  if (userInfoCache.has(userId)) return userInfoCache.get(userId);

  try {
    const res = await fetch(`https://cachet.dunkirk.sh/users/${userId}`);
    if (!res.ok) throw new Error(`cachet request failed: ${res.status}`);
    const data = await res.json();
    const info = { displayName: data?.displayName || fallbackName, imageUrl: data?.imageUrl || null };
    userInfoCache.set(userId, info);
    return info;
  } catch (error) {
    console.error(`Failed to fetch user info for ${userId}`, error);
    userInfoCache.set(userId, fallback);
    return fallback;
  }
}

app.get('/', async (req, res, next) => {
  try {
    const channels = await db('channels').select('name', 'galaxy').orderBy('galaxy');

    const planets = await db('planets')
      .select('planets.id', 'planets.name', 'planets.galaxy', 'planets.user', 'users.username')
      .leftJoin('users', 'users.user_id', 'planets.user')
      .orderBy('planets.id');

    const uniqueUserIds = [...new Set(planets.map((p) => p.user).filter(Boolean))];
    await Promise.all(
      uniqueUserIds.map((userId) => {
        const fallback = planets.find((p) => p.user === userId)?.username || null;
        return getUserInfo(userId, fallback);
      })
    );

    const toPlanet = (p) => ({ id: p.id, name: p.name, owner: userInfoCache.get(p.user)?.displayName ?? p.username });

    const leaderboard = uniqueUserIds
      .map((userId) => ({
        userId,
        displayName: userInfoCache.get(userId)?.displayName ?? 'unknown',
        imageUrl: userInfoCache.get(userId)?.imageUrl ?? null,
        planetCount: planets.filter((p) => p.user === userId).length,
      }))
      .sort((a, b) => b.planetCount - a.planetCount);

    const galaxyNames = new Set(channels.map((c) => c.galaxy));

    const hiddenGalaxies = new Set(['Oblique Arm', 'Elysian Spiral']);
    const displayPlanets = planets.filter((p) => !hiddenGalaxies.has(p.galaxy));

    await Promise.all(channels.map((c) => getChannelName(c.name)));

    const galaxies = channels
      .map((c) => ({
        name: c.galaxy,
        channel: channelNameCache.get(c.name) ?? c.name,
        planets: displayPlanets.filter((p) => p.galaxy === c.galaxy).map(toPlanet),
      }))
      .filter((g) => g.planets.length > 0);

    const orphanPlanets = displayPlanets.filter((p) => !galaxyNames.has(p.galaxy));
    if (orphanPlanets.length) {
      const byGalaxy = new Map();
      for (const p of orphanPlanets) {
        if (!byGalaxy.has(p.galaxy)) byGalaxy.set(p.galaxy, []);
        byGalaxy.get(p.galaxy).push(toPlanet(p));
      }
      for (const [channelId, list] of byGalaxy) {
        const channelName = await getChannelName(channelId);
        galaxies.push({ name: channelName, channel: channelName, planets: list });
      }
    }

    const channelLeaderboard = galaxies
      .map((g) => ({ channel: g.channel, galaxy: g.name, planetCount: g.planets.length }))
      .sort((a, b) => b.planetCount - a.planetCount);

    const visualizedGalaxies = galaxies.filter((g) => g.planets.length > 1);
    const graphData = JSON.stringify({ galaxies: splitLargeGalaxies(visualizedGalaxies) }).replace(/</g, '\\u003c');

    res.render('index.html', { graphData, leaderboard, channelLeaderboard });
  } catch (error) {
    next(error);
  }
});

const PORT = process.env.WEB_PORT || 4000;

app.listen(PORT, () => {
  console.log(`🌌 Galaxy viewer running at http://localhost:${PORT}`);
});
