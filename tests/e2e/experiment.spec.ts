import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { controlWave, guardedWave, trialWave } from '../../src/lib/dsp/experiment';
import { encodeRecording } from '../../src/lib/audio/recording';
import { CONTROL_FSK, defaultSearch, hexBytes, trialPayload, validateSearch } from '../../src/lib/experiment';
import manifest from '../../package.json' with { type: 'json' };
/** Result rows without the per-run divider, whose timestamp differs between runs. */
const resultRows=(page:import('@playwright/test').Page)=>page.locator('[data-testid=experiment-results] tbody tr:not(.run-divider)');
const sampleRate=48000,config=validateSearch(defaultSearch()),proposal={sender:719,trial:0,settings:config.trial};
const packetHex=hexBytes(trialPayload(config.trial));
const testLine=`<- 02CF#2 test packet ${packetHex} · trial 1: received, 64/64 symbols received, S/N dB [`;
const a=guardedWave(controlWave({kind:'test_suite',...proposal},sampleRate,1,true),sampleRate),b=guardedWave(trialWave(proposal,sampleRate,2),sampleRate);
const samples=new Float32Array(a.length+b.length);samples.set(a);samples.set(b,a.length);
const wav=encodeRecording({samples,metadata:{format:'sonic-recording',version:1,appVersion:manifest.version,createdAt:'2026-09-14',sampleRate,fsk:CONTROL_FSK,inputSettings:{},userAgent:'fixture',notes:'',cooperative:{version:1,config}}});
test('replays cooperative audio without microphone access and receives the test packet again',async({page})=>{
  await page.addInitScript(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw Error('Replay must not request a microphone');};});
  await page.goto('/sonic-messaging/#tests');
  await expect(page.locator('.brand-copy small')).toHaveText(`v${manifest.version}`);
  await page.getByLabel('Load experiment WAV').setInputFiles({name:'cooperative.wav',mimeType:'audio/wav',buffer:Buffer.from(wav)});
  await page.getByRole('button',{name:'Replay experiment',exact:true}).click();
  await expect(page.getByTestId('experiment-status')).toContainText('Replay complete.',{timeout:120000});
  await expect(page.getByTestId('experiment-results')).toContainText('received');
  await expect(page.getByTestId('experiment-results')).toContainText('0/64');
  await expect(page.getByTestId('experiment-log')).toContainText('<- 02CF#1 test_suite(1, 1500, 4, 25, 16, 719, 40, 0) · trial 1 settings');
  await expect(page.getByTestId('experiment-log')).toContainText(testLine);
  const original=await resultRows(page).allInnerTexts();
  await page.getByRole('button',{name:'Replay experiment',exact:true}).click();
  await expect(page.getByTestId('experiment-status')).toContainText('Replay complete.',{timeout:120000});
  await expect(resultRows(page)).toHaveText(original,{useInnerText:true});
  const pending=page.waitForEvent('download');
  await page.getByRole('button',{name:'Save experiment WAV',exact:true}).click();
  expect((await pending).suggestedFilename()).toBe('sonic-cooperative.wav');
});
test('validates settings before requesting a microphone and estimates run length',async({page})=>{
  await page.goto('/sonic-messaging/#tests');
  await expect(page.getByRole('button',{name:'Run one trial'})).toHaveCount(0);
  await expect(page.getByTestId('test-estimate')).toContainText('5 tests · ≈');
  await expect(page.getByTestId('test-estimate')).not.toContainText('over the 10-minute');
  await page.getByLabel('Repetitions per test').fill('9');
  await expect(page.getByTestId('test-estimate')).toContainText('45 tests');
  await expect(page.getByTestId('test-estimate')).toContainText('over the 10-minute session limit');
  await page.getByLabel('Payload bytes').fill('200');
  await page.getByRole('button',{name:'Start Test',exact:true}).click();
  await expect(page.locator('.experiment [role=alert]')).toContainText('Invalid trial settings');
});

const liveRate=48000;
const pieces=[new Float32Array(liveRate*2),guardedWave(controlWave({kind:'test_suite',...proposal},liveRate,1,true),liveRate),new Float32Array(liveRate*3),guardedWave(trialWave(proposal,liveRate,2),liveRate),new Float32Array(liveRate*3),guardedWave(controlWave({kind:'done',sender:719,trial:1},liveRate,3,true),liveRate)];
const liveSamples=new Float32Array(pieces.reduce((n,p)=>n+p.length,0));let position=0;for(const piece of pieces){liveSamples.set(piece,position);position+=piece.length;}
const header=Buffer.alloc(44),data=Buffer.alloc(liveSamples.length*2);
header.write('RIFF');header.writeUInt32LE(36+data.length,4);header.write('WAVE',8);header.write('fmt ',12);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(liveRate,24);header.writeUInt32LE(liveRate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(data.length,40);
for(let i=0;i<liveSamples.length;i++)data.writeInt16LE(Math.round(liveSamples[i]*32767),i*2);
const dir=join(tmpdir(),'sonic-cooperative-tests');mkdirSync(dir,{recursive:true});const path=join(dir,'conversation.wav');writeFileSync(path,Buffer.concat([header,data]));
test.use({launchOptions:{args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${path}`]}});
test.describe('live partner',()=>{
  test('captures negotiated test data and saves a replayable recording',async({page})=>{
    test.setTimeout(240000);await page.goto('/sonic-messaging/#tests');
    await page.getByLabel('Payload bytes').fill('200'); // Partner settings are ignored, even when invalid.
    await page.getByRole('button',{name:'Listen as partner',exact:true}).click();
    await expect(page.getByTestId('experiment-status')).toContainText('Controller finished; still listening',{timeout:90000});
    await expect(page.locator('.experiment [role=alert]')).toHaveCount(0);
    // The packet is received and scored; a slow CI machine can glitch its own audio capture, so a failed CRC
    // (with every symbol still scored) counts as reception too. Only "lost" would mean the pipeline broke.
    await expect(page.getByTestId('experiment-results')).toContainText(/received|CRC failed/);
    await expect(page.getByTestId('experiment-results')).not.toContainText('lost');
    await expect(page.getByTestId('experiment-results')).toContainText('/64');
    const log=page.getByTestId('experiment-log');
    // Received frames show <- with the controller's sender#seq; the partner's own transmissions show ->.
    for(const line of ['<- 02CF#1 test_suite(1, 1500, 4, 25, 16, 719, 40, 0)',' ACK 02CF#1',`<- 02CF#2 test packet `,
      '<- 02CF#3 done(1) · run finished after 1 trials',' ACK 02CF#3'])await expect(log).toContainText(line);
    await expect(log).toContainText(/-> [0-9A-F]{4}#\d+ ACK 02CF#1/);
    await expect(log).toContainText(/-> [0-9A-F]{4}#\d+ result\(1, \d+, 64, \d+, 128,/);
    await page.getByRole('button',{name:'Stop experiment',exact:true}).click();
    const original=await resultRows(page).allInnerTexts();
    const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Save experiment WAV',exact:true}).click();
    const saved=await (await pending).path();if(!saved)throw Error('Missing capture');
    await page.getByLabel('Load experiment WAV').setInputFiles(saved);
    await page.getByRole('button',{name:'Replay experiment',exact:true}).click();
    await expect(page.getByTestId('experiment-status')).toContainText('Replay complete.',{timeout:120000});
    await expect(resultRows(page)).toHaveText(original,{useInnerText:true});
    // The live run was saved to browser storage while recording and survives a reload.
    await page.reload();
    const recordings=page.getByTestId('recordings');
    await expect(recordings.locator('tbody tr')).toHaveCount(1);
    await expect(recordings.locator('tbody tr')).toContainText('partner');
    await expect(recordings.locator('tbody tr')).toContainText('1');
    const stored=page.waitForEvent('download');await recordings.getByRole('button',{name:'Save WAV'}).click();
    expect((await stored).suggestedFilename()).toMatch(/^sonic-partner-.*\.wav$/);
    await recordings.getByRole('button',{name:'Replay'}).click();
    await expect(page.getByTestId('experiment-status')).toContainText('Replay complete.',{timeout:120000});
    await expect(resultRows(page)).toHaveText(original,{useInnerText:true});
    page.once('dialog',dialog=>dialog.accept());
    await recordings.getByRole('button',{name:'Clear all'}).click();
    await expect(recordings).toContainText('No saved recordings.');
  });
});
