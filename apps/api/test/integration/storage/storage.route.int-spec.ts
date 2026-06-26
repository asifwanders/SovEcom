/**
 * Integration tests for the StorageController /uploads/* route.
 *
 * Boots the full NestJS app with STORAGE_DRIVER=local pointing at a tmp dir.
 * Tests:
 *   - Valid key → 200 with body.
 *   - Valid signed URL → 200.
 *   - Expired/tampered signed URL → 403.
 *   - Path-traversal attempt → 400 or 404 (never escapes tmp root).
 *   - Missing file → 404.
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../../src/app.module';
import { AllExceptionsFilter } from '../../../src/common/filters/all-exceptions.filter';

describe('StorageController /uploads/* (integration)', () => {
  let app: INestApplication;
  let tmpDir: string;
  const secret = 'route-test-secret';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovecom-route-test-'));

    process.env['STORAGE_DRIVER'] = 'local';
    process.env['LOCAL_STORAGE_PATH'] = tmpDir;
    process.env['STORAGE_SIGNING_SECRET'] = secret;
    process.env['PUBLIC_BASE_URL'] = 'http://localhost:3000';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Mirror main.ts global filter so HTTP exceptions map to correct status codes.
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeFile(key: string, content: Buffer): void {
    const dest = path.join(tmpDir, key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }

  function signedParams(key: string, expiresOffset = 300) {
    const expires = Math.floor(Date.now() / 1000) + expiresOffset;
    const sig = crypto.createHmac('sha256', secret).update(`${key}|${expires}`).digest('hex');
    return { expires, sig };
  }

  it('GET /uploads/<key> returns 200 with correct body for an existing file', async () => {
    const key = 'tenant-1/products/prod-1/hello.txt';
    const content = Buffer.from('hello route test');
    writeFile(key, content);

    const res = await request(app.getHttpServer())
      .get(`/uploads/${key}`)
      .responseType('blob')
      .expect(200);

    // res.body is a Buffer when responseType('blob') is set.
    expect(Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.text)).toEqual(content);
  });

  it('GET /uploads/<key> returns 404 for a missing file', async () => {
    await request(app.getHttpServer())
      .get('/uploads/tenant-1/products/prod-1/missing.txt')
      .expect(404);
  });

  it('GET /uploads/<key>?expires=&sig= returns 200 with valid signature', async () => {
    const key = 'tenant-1/products/prod-2/signed.txt';
    const content = Buffer.from('signed content');
    writeFile(key, content);

    const { expires, sig } = signedParams(key);

    await request(app.getHttpServer())
      .get(`/uploads/${key}?expires=${expires}&sig=${sig}`)
      .expect(200);
  });

  it('GET /uploads/<key> returns 403 when signature is expired', async () => {
    const key = 'tenant-1/products/prod-2/signed.txt';
    const { expires, sig } = signedParams(key, -10); // 10 s in the past

    await request(app.getHttpServer())
      .get(`/uploads/${key}?expires=${expires}&sig=${sig}`)
      .expect(403);
  });

  it('GET /uploads/<key> returns 403 when signature is tampered', async () => {
    const key = 'tenant-1/products/prod-2/signed.txt';
    const { expires } = signedParams(key);
    const badSig = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    await request(app.getHttpServer())
      .get(`/uploads/${key}?expires=${expires}&sig=${badSig}`)
      .expect(403);
  });

  it('GET /uploads/ with ".." in path never escapes the storage root', async () => {
    // Node.js HTTP stack normalises "../" out of URLs before routing, so
    // `/uploads/tenant-1/../etc/passwd` becomes `/uploads/etc/passwd`.
    // The resulting key `etc/passwd` is a valid 2-segment path that simply
    // returns 404 (the file doesn't exist) — it cannot escape the tmp root.
    await request(app.getHttpServer()).get('/uploads/tenant-1/../etc/passwd').expect(404);
  });
});
