import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { controlWave, guardedWave, trialWave } from '../../src/lib/dsp/experiment';
import { encodeRecording } from '../../src/lib/audio/recording';
import { CONTROL_FSK, defaultSearch, validateSearch } from '../../src/lib/experiment';
import manifest from '../../package.json' with { type: 'json' };
const sampleRate=8000,config=validateSearch(defaultSearch()),proposal={session:719,trial:0,settings:config.trial};
const a=guardedWave(controlWave({kind:'propose',...proposal},sampleRate),sampleRate),b=guardedWave(trialWave(proposal,sampleRate),sampleRate);
const samples=new Float32Array(a.length+b.length);samples.set(a);samples.set(b,a.length);
const wav=encodeRecording({samples,metadata:{format:'sonic-recording',version:1,appVersion:manifest.version,createdAt:'2026-09-14',sampleRate,fsk:CONTROL_FSK,inputSettings:{},userAgent:'fixture',notes:'',cooperative:{version:1,config}}});
test('replays cooperative audio without microphone access and recomputes raw and acquisition results',async({page})=>{
  await page.addInitScript(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw Error('Replay must not request a microphone');};});
  await page.goto('/sonic-messaging/#tests');
  await expect(page.locator('.brand-copy small')).toHaveText(`v${manifest.version}`);
  await page.getByLabel('Load experiment WAV').setInputFiles({name:'cooperative.wav',mimeType:'audio/wav',buffer:Buffer.from(wav)});
  await page.getByRole('button',{name:'Replay experiment',exact:true}).click();
  await expect(page.getByTestId('experiment-status')).toContainText('Replay complete.',{timeout:20000});
  await expect(page.getByTestId('experiment-results')).toContainText('0/64');
  await expect(page.getByTestId('experiment-results')).not.toContainText('0/128');
  await expect(page.getByTestId('experiment-results')).toContainText('4/4 exact');
  await expect(page.getByTestId('experiment-log')).toContainText('Trial 1, Tones=4, Base=1000, Delta=200, Baud=100: Symbols received 64/64');
  const original=await page.getByTestId('experiment-results').innerText();
  await page.getByRole('button',{name:'Replay experiment',exact:true}).click();
  await expect(page.getByTestId('experiment-status')).toContainText('Replay complete.',{timeout:20000});
  await expect(page.getByTestId('experiment-results')).toHaveText(original,{useInnerText:true});
  const pending=page.waitForEvent('download');
  await page.getByRole('button',{name:'Save experiment WAV',exact:true}).click();
  expect((await pending).suggestedFilename()).toBe('sonic-cooperative.wav');
});
test('validates test power before requesting a microphone',async({page})=>{
  await page.goto('/sonic-messaging/#tests');
  await page.getByLabel('Test amplitude').fill('0.9');
  await page.getByRole('button',{name:'Run one trial',exact:true}).click();
  await expect(page.locator('.experiment [role=alert]')).toContainText('Invalid trial settings');
});

const liveRate=48000;
const pieces=[new Float32Array(liveRate*2),guardedWave(controlWave({kind:'propose',...proposal},liveRate),liveRate),new Float32Array(liveRate*3),guardedWave(trialWave(proposal,liveRate),liveRate),new Float32Array(liveRate*3),guardedWave(controlWave({kind:'done',session:719,trial:1},liveRate),liveRate)];
const liveSamples=new Float32Array(pieces.reduce((n,p)=>n+p.length,0));let position=0;for(const piece of pieces){liveSamples.set(piece,position);position+=piece.length;}
const header=Buffer.alloc(44),data=Buffer.alloc(liveSamples.length*2);
header.write('RIFF');header.writeUInt32LE(36+data.length,4);header.write('WAVE',8);header.write('fmt ',12);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(liveRate,24);header.writeUInt32LE(liveRate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(data.length,40);
for(let i=0;i<liveSamples.length;i++)data.writeInt16LE(Math.round(liveSamples[i]*32767),i*2);
const dir=join(tmpdir(),'sonic-cooperative-tests');mkdirSync(dir,{recursive:true});const path=join(dir,'conversation.wav');writeFileSync(path,Buffer.concat([header,data]));
test.use({launchOptions:{args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${path}`]}});
test.describe('live partner',()=>{
  test('captures negotiated test data and saves a replayable recording',async({page})=>{
    test.setTimeout(45000);await page.goto('/sonic-messaging/#tests');
    await page.getByRole('button',{name:'Listen as partner',exact:true}).click();
    await expect(page.getByTestId('experiment-status')).toContainText('Controller finished.',{timeout:25000});
    await expect(page.getByTestId('experiment-results')).toContainText('0/64');
    await expect(page.getByTestId('experiment-log')).toContainText('-> Trial 1, Tones=4, Base=1000, Delta=200, Baud=100');
    await expect(page.getByTestId('experiment-log')).toContainText('<- Symbols received 64/64');
    const original=await page.getByTestId('experiment-results').innerText();
    const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Save experiment WAV',exact:true}).click();
    const saved=await (await pending).path();if(!saved)throw Error('Missing capture');
    await page.getByLabel('Load experiment WAV').setInputFiles(saved);
    await page.getByRole('button',{name:'Replay experiment',exact:true}).click();
    await expect(page.getByTestId('experiment-status')).toContainText('Replay complete.',{timeout:20000});
    await expect(page.getByTestId('experiment-results')).toHaveText(original,{useInnerText:true});
  });
});
