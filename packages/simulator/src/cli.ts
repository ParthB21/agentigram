import { parseArgs } from 'node:util';
import pino from 'pino';
import { SCENARIOS } from './scenarios/index.js';
import { createMockCoordinator } from './server.js';

const { values } = parseArgs({
  options: {
    scenario: { type: 'string', default: 'user-id-uuid' },
    port: { type: 'string', default: '8787' },
    room: { type: 'string', default: 'hackathon' },
    speed: { type: 'string', default: '1' },
    'no-play': { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help || values.list) {
  console.log(
    'pnpm sim [--scenario <name>] [--port 8787] [--room hackathon] [--speed 1] [--no-play]',
  );
  console.log(`scenarios: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(0);
}

const scenario = SCENARIOS[values.scenario ?? ''];
if (!scenario) {
  console.error(
    `unknown scenario "${values.scenario}". Available: ${Object.keys(SCENARIOS).join(', ')}`,
  );
  process.exit(1);
}

const logger = pino({ name: 'sim' });
const coordinator = await createMockCoordinator({
  port: Number(values.port),
  log: (line) => logger.info(line),
});
const roomId = values.room ?? 'hackathon';
logger.info(`mock coordinator on ws://localhost:${coordinator.port}/room/${roomId}`);

if (values['no-play']) {
  logger.info('idle: no scenario playing (--no-play)');
} else {
  logger.info(`playing "${scenario.name}" into room ${roomId} (${scenario.steps.length} events)`);
  void coordinator.play(scenario, { roomId, speed: Number(values.speed) }).then(() => {
    const head = coordinator.room(roomId).state.lastSeq;
    logger.info(`scenario finished at seq ${head}; still serving replays. Ctrl+C to stop.`);
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void coordinator.close().then(() => process.exit(0)));
}
