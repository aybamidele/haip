import 'reflect-metadata';
import { Module, type LoggerService } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DatabaseModule } from './database/database.module';
import { IcalModule } from './modules/ical/ical.module';
import { IcalPollingService } from './modules/ical/ical-polling.service';

// Only our fixed event objects reach stdout; framework/database exceptions may contain secrets.
class WorkerLogger implements LoggerService {
  private write(level: string, message: unknown): void {
    const event = message && typeof message === 'object' && 'event' in message
      ? message : { event: 'ical_worker_framework_event' };
    process.stdout.write(JSON.stringify({ service: 'haip-calendar-worker', level, time: new Date().toISOString(), ...event }) + '\n');
  }
  log(message: unknown): void { if (typeof message === 'object') this.write('info', message); }
  warn(message: unknown): void { this.write('warn', message); }
  error(message: unknown): void { this.write('error', message); }
}

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule, IcalModule],
  providers: [IcalPollingService],
})
class CalendarWorkerModule {}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(CalendarWorkerModule, { logger: new WorkerLogger(), abortOnError: false });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void close());
  process.on('SIGINT', () => void close());
}
void bootstrap().catch(() => {
  process.stderr.write('{"service":"haip-calendar-worker","level":"error","event":"ical_worker_startup_failed"}\n');
  process.exit(1);
});
