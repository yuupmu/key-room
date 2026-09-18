(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const names = ['도','도♯','레','레♯','미','파','파♯','솔','솔♯','라','라♯','시'];
  const pitchNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const pianoSamples = {
    A0:'A0.mp3',C1:'C1.mp3','D#1':'Ds1.mp3','F#1':'Fs1.mp3',A1:'A1.mp3',
    C2:'C2.mp3','D#2':'Ds2.mp3','F#2':'Fs2.mp3',A2:'A2.mp3',
    C3:'C3.mp3','D#3':'Ds3.mp3','F#3':'Fs3.mp3',A3:'A3.mp3',
    C4:'C4.mp3','D#4':'Ds4.mp3','F#4':'Fs4.mp3',A4:'A4.mp3',
    C5:'C5.mp3','D#5':'Ds5.mp3','F#5':'Fs5.mp3',A5:'A5.mp3',
    C6:'C6.mp3','D#6':'Ds6.mp3','F#6':'Fs6.mp3',A6:'A6.mp3',
    C7:'C7.mp3','D#7':'Ds7.mp3','F#7':'Fs7.mp3',A7:'A7.mp3',C8:'C8.mp3'
  };
  const blackKeys = new Set([1,3,6,8,10]);
  const computerWhiteKeys = ['KeyA','KeyS','KeyD','KeyF','KeyG','KeyH','KeyJ','KeyK','KeyL'];
  const computerBlackKeys = new Map([['KeyW',[0,1]],['KeyE',[1,3]],['KeyT',[3,6]],['KeyY',[4,8]],['KeyU',[5,10]],['KeyO',[7,13]]]);
  const computerWhiteOffsets = [0,2,4,5,7,9,11,12,14];
  const computerNoteOffsets = new Map([...computerWhiteKeys.map((code,index)=>[code,computerWhiteOffsets[index]]),...[...computerBlackKeys].map(([code,[,offset]])=>[code,offset])]);
  const midiColors = ['#a3df5c','#87a9cc','#b791e6'];
  const state = {
    tracks:[],nextTrackId:1,selectedAudioTrack:null,fileTarget:null,originalBpm:null,originalBpmManual:false,gridBpm:120,gridBpmManual:false,
    midiFile:null,notes:[],midiTailDuration:0,midiDuration:0,tempoPoints:[],ticksPerBeat:480,nextId:1,
    position:0,playing:false,speed:1,speedFactor:1,fallScale:44.8,fallKeyWidth:40,startedAt:0,startedPosition:0,
    ctx:null,pianoLoad:null,pianoBuffers:null,livePiano:null,playStartId:0,nextNote:0,timer:null,raf:null,tab:'fall',history:[],selectedNoteId:null,editorStart:0,
    metronomeOn:false,metronomeVolume:1,metronomeTimer:null,metronomeBeat:0,metronomeWhen:0,metronomeSources:new Set(),
    toastTimer:null,lastFocus:null,selectedTrack:null,practiceTrackId:null,editorViewSeconds:8,editorRowHeight:22,editorGesture:null,practiceFlagTime:null,practiceDrag:null,
    midiAccess:null,midiInput:null,midiInputId:'',heldNotes:new Map(),performanceNotes:[],recordingNotes:new Map(),recording:false,
    computerKeyboardOn:false,computerBase:60,computerVelocity:90
  };
  const el = {
    play:$('playButton'),glyph:$('playGlyph'),stop:$('stopButton'),metronome:$('metronomeToggle'),metronomeVolume:$('metronomeVolume'),metronomeVolumeValue:$('metronomeVolumeValue'),current:$('currentTime'),duration:$('durationTime'),
    seek:$('seekBar'),speed:$('speedSelect'),originalBpm:$('originalBpmInput'),bpm:$('bpmInput'),audioInput:$('audioInput'),midiInput:$('midiInput'),trackRows:$('trackRows'),trimWave:$('trimWaveform'),summary:$('fileSummary'),
    fall:$('fallCanvas'),roll:$('rollCanvas'),fallEmpty:$('fallEmpty'),rollEmpty:$('rollEmpty'),fallSpeedLabel:$('fallSpeedLabel'),fallNoteProgress:$('fallNoteProgress'),
    noteCount:$('noteCount'),ruler:$('ruler'),toast:$('toast'),trimRange:$('trimRange'),trimSeconds:$('trimSeconds'),leadInRange:$('leadInRange'),leadInSeconds:$('leadInSeconds'),
    practiceTrackPicker:$('practiceTrackPicker'),practiceScrub:$('practiceScrub'),practiceBeatGrid:$('practiceBeatGrid'),practiceMidiNotes:$('practiceMidiNotes'),practiceScrubEmpty:$('practiceScrubEmpty'),practicePosition:$('practicePosition'),practiceFlag:$('practiceFlag'),practiceTime:$('practiceTime'),placePracticeFlag:$('placePracticeFlag'),clearPracticeFlag:$('clearPracticeFlag'),timelineFlagLayer:$('timelineFlagLayer'),timelineFlag:$('timelineFlag'),placeTimelineFlag:$('placeTimelineFlag'),clearTimelineFlag:$('clearTimelineFlag'),
    sourceDuration:$('sourceDuration'),trimStartLabel:$('trimStartLabel'),leadInLabel:$('leadInLabel'),trimRemaining:$('trimRemaining'),audioPitchValue:$('audioPitchValue'),
    editorGrid:$('editorGrid'),editorScroll:$('editorScroll'),editorWindow:$('editorWindow'),editorWindowLabel:$('editorWindowLabel'),editorTrack:$('editorTrack'),editorZoomLabel:$('editorZoomLabel'),selectedNoteInfo:$('selectedNoteInfo'),undoMidi:$('undoMidi'),editNoteCount:$('editNoteCount'),
    connectMidi:$('connectMidi'),midiDevice:$('midiDevice'),midiStatus:$('midiStatus'),liveNotes:$('liveNotes'),liveNoteText:$('liveNoteText'),recordPerformance:$('recordPerformance'),clearPerformance:$('clearPerformance'),downloadPerformance:$('downloadPerformance'),performanceStatus:$('performanceStatus'),
    toggleComputerKeyboard:$('toggleComputerKeyboard'),computerKeyboardStatus:$('computerKeyboardStatus'),computerKeyboardLayout:$('computerKeyboardLayout')
  };

  const clamp = (value,min,max) => Math.max(min,Math.min(max,value));
  const noteName = pitch => names[pitch%12] + (Math.floor(pitch/12)-1);
  const pianoNote = pitch => pitchNames[pitch%12] + (Math.floor(pitch/12)-1);
  function fmt(seconds){const s=Math.floor(Math.max(0,Number.isFinite(seconds)?seconds:0));return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`}
  const trackById = id => state.tracks.find(track=>track.id===id);
  const audioTracks = () => state.tracks.filter(track=>track.type==='audio');
  const midiTracks = () => state.tracks.filter(track=>track.type==='midi');
  const midiColor = id => midiColors[Math.max(0,midiTracks().findIndex(track=>track.id===id))%midiColors.length];
  const audioLength = track => Math.max(0,(track?.leadIn||0)+(track?.sourceDuration||0)-(track?.trimStart||0));
  const audioSourceTime = (track, position) => (track?.trimStart||0)+position-(track?.leadIn||0);
  function duration(){return Math.max(state.midiDuration,0,...audioTracks().map(audioLength))}
  function toast(message){el.toast.textContent=message;el.toast.classList.add('show');clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>el.toast.classList.remove('show'),3300)}
  function ensureContext(){if(!state.ctx){const Context=window.AudioContext||window.webkitAudioContext;if(Context)state.ctx=new Context()}return state.ctx}
  function loadPiano(){
    if(!window.Tone)return Promise.reject(Error('Tone.js를 불러오지 못했습니다.'));
    if(!state.pianoLoad)state.pianoLoad=new Promise((resolve,reject)=>{
      const buffers=new Tone.Buffers({urls:pianoSamples,baseUrl:'./assets/salamander/',onload:()=>{state.pianoBuffers=buffers;resolve(buffers)},onerror:reject});
    });
    return state.pianoLoad;
  }
  async function preparePiano(){
    if(!window.Tone)throw Error('Tone.js를 불러오지 못했습니다.');
    await Promise.all([Tone.start(),loadPiano()]);
  }
  function createPiano(){
    const urls=Object.fromEntries(Object.keys(pianoSamples).map(note=>[note,state.pianoBuffers.get(note)]));
    return new Tone.Sampler({urls,release:.2}).toDestination();
  }
  function setTrackVolume(track){
    if(!track)return;
    const volume=track.muted?0:clamp(track.volume,0,1);
    if(track.audioGain){track.audioGain.gain.value=volume;track.audio.volume=1;track.audio.muted=false}
    else if(track.audio){track.audio.volume=clamp(track.volume,0,1);track.audio.muted=track.muted}
    if(track.piano?.volume)track.piano.volume.value=volume<=0?-Infinity:20*Math.log10(volume);
  }
  function routeAudioPitch(track){
    if(!track.pitchNode)return;
    const now=state.ctx.currentTime;
    for(const [gain,value] of [[track.pitchDry,track.pitch===0?1:0],[track.pitchWet,track.pitch===0?0:1]]){
      gain.gain.cancelScheduledValues(now);
      gain.gain.setTargetAtTime(value,now,.012);
    }
  }
  function disconnectAudioPitch(track){
    track.pitchVersion=(track.pitchVersion||0)+1;
    track.mediaSource?.disconnect();track.pitchNode?.disconnect();track.pitchNode?.port.close();
    track.pitchDry?.disconnect();track.pitchWet?.disconnect();track.audioGain?.disconnect();
    track.mediaSource=null;track.pitchNode=null;track.pitchDry=null;track.pitchWet=null;track.audioGain=null;
  }
  async function connectAudioPitch(track,file){
    if(track.pitchNode)return track.pitchNode;
    if(track.pitchSetup){
      if(track.pitchSetupFile===file)return track.pitchSetup;
      try{await track.pitchSetup}catch(e){/* The previous file's setup can fail independently. */}
      if(track.file!==file)return null;
      if(track.pitchNode)return track.pitchNode;
    }
    track.pitchSetupFile=file;
    const setup=(async()=>{
      if(!state.ctx?.audioWorklet)throw Error('이 브라우저에서는 고품질 오디오 조옮김을 사용할 수 없습니다.');
      const {default:SignalsmithStretch}=await import('./signalsmith-stretch.mjs');
      if(track.file!==file||!state.tracks.includes(track))return null;
      const context=state.ctx;
      const pitchNode=await SignalsmithStretch(context);
      if(track.file!==file||!state.tracks.includes(track)){pitchNode.port.close();pitchNode.disconnect();return null}
      const dry=context.createGain(),wet=context.createGain(),gain=context.createGain();
      let source;
      try{
        dry.gain.value=1;wet.gain.value=0;
        pitchNode.connect(wet);dry.connect(gain);wet.connect(gain);gain.connect(context.destination);
        await pitchNode.start();
        if(track.file!==file||!state.tracks.includes(track)){pitchNode.disconnect();pitchNode.port.close();dry.disconnect();wet.disconnect();gain.disconnect();return null}
        source=context.createMediaElementSource(track.audio);
        source.connect(dry);source.connect(pitchNode);
      }catch(error){source?.disconnect();pitchNode.disconnect();pitchNode.port.close();dry.disconnect();wet.disconnect();gain.disconnect();throw error}
      track.mediaSource=source;track.pitchNode=pitchNode;track.pitchDry=dry;track.pitchWet=wet;track.audioGain=gain;
      setTrackVolume(track);
      return pitchNode;
    })();
    track.pitchSetup=setup;
    try{return await setup}finally{if(track.pitchSetup===setup){track.pitchSetup=null;track.pitchSetupFile=null}}
  }
  async function transposeAudio(amount){
    const track=trackById(state.selectedAudioTrack);
    if(!track?.file)return;
    const file=track.file,version=track.pitchVersion=(track.pitchVersion||0)+1;
    track.pitch+=amount;
    updateTrimControls();refreshSummary();
    try{
      if(track.pitch!==0&&!track.pitchNode)toast('고품질 오디오 조옮김을 준비하고 있습니다…');
      if(track.pitch!==0){const context=ensureContext();if(!context)throw Error('오디오 기능을 사용할 수 없습니다.');if(context.state==='suspended')await context.resume()}
      if(track.pitch!==0)await connectAudioPitch(track,file);
      if(track.file!==file||!state.tracks.includes(track)||version!==track.pitchVersion)return;
      if(track.pitchNode){await track.pitchNode.schedule({semitones:track.pitch});if(version!==track.pitchVersion)return;routeAudioPitch(track)}
      toast(`오디오 조를 ${track.pitch>0?`+${track.pitch}`:track.pitch}반음으로 설정했습니다.`);
    }catch(error){
      if(track.file!==file||version!==track.pitchVersion)return;
      track.pitch=0;routeAudioPitch(track);updateTrimControls();refreshSummary();
      toast(error.message||'오디오 조를 바꾸지 못했습니다.');
    }
  }
  function currentPosition(){return state.playing?clamp(state.startedPosition+(performance.now()-state.startedAt)*state.speed/1000,0,duration()):state.position}
  function stopMetronomeClicks(){for(const source of state.metronomeSources){try{source.stop()}catch(e){}}state.metronomeSources.clear()}
  function soundMetronomeBeat(beat,when){
    const ctx=state.ctx,accent=beat%4===0,oscillator=ctx.createOscillator(),gain=ctx.createGain();
    oscillator.type='square';oscillator.frequency.setValueAtTime(accent?1320:880,when);
    gain.gain.setValueAtTime((accent?.075:.045)*state.metronomeVolume,when);
    gain.gain.exponentialRampToValueAtTime(.0001,when+(accent?.065:.045));
    oscillator.connect(gain);gain.connect(ctx.destination);
    oscillator.start(when);oscillator.stop(when+(accent?.07:.05));
    state.metronomeSources.add(oscillator);
    oscillator.onended=()=>{state.metronomeSources.delete(oscillator);oscillator.disconnect();gain.disconnect()};
  }
  function scheduleMetronome(){
    if(!state.metronomeOn||!state.ctx)return;
    const now=state.ctx.currentTime,until=now+.25;
    const position=state.playing?currentPosition():0;
    const interval=60/(state.gridBpm*state.speedFactor);
    if(state.playing)state.metronomeBeat=Math.max(state.metronomeBeat,Math.ceil(secondsToBeat(position)-.04));
    else if(state.metronomeWhen<now-interval){
      const missed=Math.ceil((now-state.metronomeWhen)/interval);
      state.metronomeBeat+=missed;state.metronomeWhen+=missed*interval;
    }
    for(let count=0;count<16;count++){
      const beat=state.metronomeBeat;
      const songTime=state.playing?beatToSeconds(beat):0;
      const when=state.playing?now+(songTime-position)/state.speed:state.metronomeWhen;
      if((state.playing&&songTime>=duration())||when>=until)break;
      if(when>=now-.02)soundMetronomeBeat(beat,Math.max(now+.002,when));
      state.metronomeBeat++;
      if(!state.playing)state.metronomeWhen+=interval;
    }
  }
  function resetMetronomeClock(continueFromSong=false){
    if(!state.metronomeOn||!state.ctx)return;
    stopMetronomeClicks();
    const position=currentPosition();
    state.metronomeBeat=state.playing||continueFromSong?Math.max(0,Math.ceil(secondsToBeat(position)-.0001)):0;
    state.metronomeWhen=state.ctx.currentTime+(continueFromSong?Math.max(.01,(beatToSeconds(state.metronomeBeat)-position)/state.speed):.01);
    scheduleMetronome();
  }
  async function toggleMetronome(){
    state.metronomeOn=!state.metronomeOn;
    el.metronome.setAttribute('aria-pressed',String(state.metronomeOn));
    el.metronome.setAttribute('aria-label',state.metronomeOn?'메트로놈 끄기':'메트로놈 켜기');
    el.metronome.textContent=state.metronomeOn?'♩ 메트로놈 끄기':'♩ 메트로놈 켜기';
    if(!state.metronomeOn){clearInterval(state.metronomeTimer);state.metronomeTimer=null;stopMetronomeClicks();return}
    const ctx=ensureContext();
    if(!ctx){toggleMetronome();toast('이 브라우저에서는 메트로놈 소리를 재생할 수 없습니다.');return}
    try{if(ctx.state==='suspended')await ctx.resume()}catch(e){
      if(state.metronomeOn)toggleMetronome();toast('메트로놈 소리를 시작하지 못했습니다.');return;
    }
    if(!state.metronomeOn)return;
    clearInterval(state.metronomeTimer);
    resetMetronomeClock();
    state.metronomeTimer=setInterval(scheduleMetronome,40);
  }
  function setMetronomeVolume(value){
    state.metronomeVolume=clamp(Number(value),0,5);
    el.metronomeVolume.value=String(state.metronomeVolume);
    el.metronomeVolumeValue.textContent=`${state.metronomeVolume.toFixed(1)}배`;
  }
  function noteIndexAt(time){let low=0,high=state.notes.length;while(low<high){const mid=(low+high)>>1;if(state.notes[mid].start<time)low=mid+1;else high=mid}return low}
  function stopNotes(){for(const track of midiTracks())track.piano?.releaseAll(Tone.immediate())}
  function stopTrackNotes(id){trackById(id)?.piano?.releaseAll(Tone.immediate())}
  function soundNote(note,when,seconds){
    const track=trackById(note.sourceTrack);
    if(!track||track.muted||!state.pianoBuffers)return;
    if(!track.piano){track.piano=createPiano();setTrackVolume(track)}
    track.piano.triggerAttackRelease(pianoNote(note.pitch),seconds,when,clamp(note.velocity/127,.05,1));
  }
  function schedule(){if(!state.playing||!state.pianoBuffers||!state.notes.length)return;const now=currentPosition(),ahead=now+.24*state.speed;while(state.nextNote<state.notes.length&&state.notes[state.nextNote].start<ahead){const note=state.notes[state.nextNote++];if(note.end<=now)continue;const when=Tone.immediate()+Math.max(0,(note.start-now)/state.speed);soundNote(note,when,Math.max(.06,note.end-Math.max(now,note.start))/state.speed)}}
  function sustainAt(time){if(!state.pianoBuffers)return;for(const note of state.notes){if(note.start<time&&note.end>time)soundNote(note,Tone.immediate()+.01,(note.end-time)/state.speed)}}
  function updateTransport(){const total=duration(),ratio=total?clamp(state.position/total,0,1):0;el.current.textContent=fmt(state.position);el.duration.textContent=fmt(total);el.seek.value=String(Math.round(ratio*1000));el.seek.style.setProperty('--progress',`${ratio*100}%`);document.querySelectorAll('.playhead').forEach(item=>item.style.left=`${ratio*100}%`);el.glyph.textContent=state.playing?'Ⅱ':'▶';el.play.setAttribute('aria-label',state.playing?'일시정지':'재생');el.play.title=state.playing?'일시정지':'재생';$('previewTrim').textContent=state.playing?'Ⅱ 미리듣기 일시정지':'▶ 시작점 들어보기';updatePracticeTransport()}
  function syncAudioPlayback(){const position=currentPosition();for(const track of audioTracks())if(track.file){const sourceTime=audioSourceTime(track,position),active=sourceTime>=track.trimStart&&sourceTime<track.sourceDuration-.01;if(active){if(track.audio.paused){track.audio.currentTime=clamp(sourceTime,0,Math.max(0,track.sourceDuration-.01));track.audio.playbackRate=state.speed;track.audio.play().catch(()=>{})}}else{track.audio.pause();if(sourceTime<track.trimStart)track.audio.currentTime=track.trimStart}}}
  function tick(){if(!state.playing)return;state.position=currentPosition();if(state.position>=duration()&&duration()>0){stopPlayback(true);return}syncAudioPlayback();updateTransport();drawViews();state.raf=requestAnimationFrame(tick)}
  async function play(fromFlag=true){
    if(!duration()){toast('먼저 오디오 또는 MIDI 파일을 추가하세요.');return}
    if(state.playing)return;
    const startId=++state.playStartId;
    if(fromFlag&&state.practiceFlagTime!==null)state.position=clamp(state.practiceFlagTime,0,Math.max(0,duration()-.01));
    else if(state.position>=duration())state.position=0;
    const ctx=ensureContext();if(ctx?.state==='suspended')await ctx.resume();
    if(startId!==state.playStartId)return;
    if(state.notes.length){
      try{await preparePiano()}catch(error){if(startId===state.playStartId)toast(error.message||'피아노 샘플을 불러오지 못했습니다.');return}
      if(startId!==state.playStartId)return;
    }
    state.playing=true;state.startedPosition=state.position;state.startedAt=performance.now();
    await Promise.all(audioTracks().filter(track=>track.file&&audioSourceTime(track,state.position)<track.sourceDuration).map(async track=>{
      const sourceTime=audioSourceTime(track,state.position);
      if(sourceTime<track.trimStart){track.audio.pause();track.audio.currentTime=track.trimStart;return}
      track.audio.currentTime=clamp(sourceTime,0,Math.max(0,track.sourceDuration-.01));
      track.audio.playbackRate=state.speed;
      try{await track.audio.play()}catch(e){toast(`${track.file.name} 오디오를 재생하지 못했습니다.`)}
    }));
    if(!state.playing)return;
    const master=audioTracks().find(track=>track.file&&!track.audio.paused);
    if(master)state.position=clamp(master.audio.currentTime-master.trimStart+master.leadIn,0,duration());
    state.startedPosition=state.position;
    state.startedAt=performance.now();state.nextNote=noteIndexAt(state.position);sustainAt(state.position);
    state.timer=setInterval(schedule,60);schedule();resetMetronomeClock();tick();updateTransport();
  }
  function pause(){state.playStartId++;if(!state.playing)return;state.position=currentPosition();stopRecording(state.position);state.playing=false;for(const track of audioTracks())track.audio?.pause();clearInterval(state.timer);cancelAnimationFrame(state.raf);stopNotes();resetMetronomeClock(true);updateTransport();drawViews()}
  function stopPlayback(ended=false){pause();state.position=ended?duration():0;for(const track of audioTracks()){track.audio?.pause();if(track.file)track.audio.currentTime=track.trimStart}updateTransport();drawViews()}
  function seek(time){
    if(state.recording)finishRecordingNotes(currentPosition());
    state.position=clamp(time,0,duration());
    for(const track of audioTracks())if(track.file){
      const sourceTime=audioSourceTime(track,state.position);
      if(sourceTime<track.trimStart){track.audio.pause();track.audio.currentTime=track.trimStart}
      else if(sourceTime<track.sourceDuration-.01){track.audio.currentTime=sourceTime;if(state.playing&&track.audio.paused)track.audio.play().catch(()=>{})}
      else{track.audio.pause();track.audio.currentTime=Math.max(0,track.sourceDuration-.01)}
    }
    if(state.playing){stopNotes();state.startedPosition=state.position;state.startedAt=performance.now();state.nextNote=noteIndexAt(state.position);sustainAt(state.position);resetMetronomeClock();if(state.recording)startHeldRecording()}updateTransport();drawViews();
  }
  function applyPlaybackSpeed(){
    if(state.playing){state.position=currentPosition();state.startedPosition=state.position;state.startedAt=performance.now();stopNotes()}
    state.speed=state.speedFactor*(state.originalBpm?state.gridBpm/state.originalBpm:1);
    for(const track of audioTracks())track.audio.playbackRate=state.speed;
    state.nextNote=noteIndexAt(state.position);
    if(state.playing)sustainAt(state.position);
    resetMetronomeClock();
  }
  function setSpeed(value){state.speedFactor=value;applyPlaybackSpeed();refreshSummary()}

  async function loadAudio(file,trackId){
    const track=trackById(trackId);if(!track||track.type!=='audio')return;
    if(!/\.(mp3|wav)$/i.test(file.name)&&!['audio/mpeg','audio/mp3','audio/wav','audio/x-wav','audio/wave'].includes(file.type)){toast('MP3 또는 WAV 파일을 선택해 주세요.');return}
    pause();if(track.url)URL.revokeObjectURL(track.url);
    track.pitchVersion=(track.pitchVersion||0)+1;
    track.file=file;track.url=URL.createObjectURL(file);track.sourceDuration=0;track.trimStart=0;track.leadIn=0;track.pitch=0;track.wavePeaks=null;
    routeAudioPitch(track);
    track.audio.src=track.url;track.audio.load();el.audioInput.value='';state.fileTarget=null;refreshSummary();
    try{if(file.size<45000000){const ctx=ensureContext();if(ctx){const buffer=await ctx.decodeAudioData(await file.arrayBuffer());if(track.file!==file)return;track.sourceDuration=buffer.duration;const data=buffer.getChannelData(0),samples=600,step=Math.max(1,Math.floor(data.length/samples)),peaks=[];for(let i=0;i<samples;i++){let maximum=0;const end=Math.min(data.length,(i+1)*step);for(let j=i*step;j<end;j+=Math.max(1,Math.floor(step/75)))maximum=Math.max(maximum,Math.abs(data[j]));peaks.push(maximum)}track.wavePeaks=peaks;refreshSummary()}}}catch(e){/* Audio can still play when waveform decoding is unavailable. */}
  }
  function readVariable(view,cursor){let value=0,byte,count=0;do{if(cursor.i>=view.byteLength)throw Error('MIDI 파일이 중간에서 끝났습니다.');byte=view.getUint8(cursor.i++);value=(value<<7)|(byte&127);if(++count>4)throw Error('잘못된 MIDI 길이입니다.')}while(byte&128);return value}
  function parseMidi(buffer){const view=new DataView(buffer),decoder=new TextDecoder(),ascii=(at,length)=>decoder.decode(new Uint8Array(buffer,at,length));if(view.byteLength<14||ascii(0,4)!=='MThd')throw Error('MIDI 파일 형식을 읽을 수 없습니다.');const headerLength=view.getUint32(4),format=view.getUint16(8),trackCount=view.getUint16(10),ticksPerBeat=view.getUint16(12);if(format>1||(ticksPerBeat&0x8000)||!ticksPerBeat)throw Error('이 MIDI 시간 형식은 아직 지원하지 않습니다.');let position=8+headerLength,notes=[],tempos=[{tick:0,us:500000}],maxTick=0;for(let track=0;track<trackCount;track++){if(position+8>view.byteLength||ascii(position,4)!=='MTrk')throw Error('MIDI 트랙을 읽을 수 없습니다.');const trackEnd=position+8+view.getUint32(position+4);if(trackEnd>view.byteLength)throw Error('MIDI 트랙 데이터가 손상되었습니다.');position+=8;let tick=0,running=0;const active=new Map();while(position<trackEnd){const cursor={i:position};tick+=readVariable(view,cursor);position=cursor.i;let status=view.getUint8(position);if(status<128){if(!running)throw Error('MIDI 이벤트 상태가 잘못되었습니다.');status=running}else{position++;if(status<0xF0)running=status}if(status===0xFF){const type=view.getUint8(position++),lengthCursor={i:position},length=readVariable(view,lengthCursor);position=lengthCursor.i;if(position+length>trackEnd)throw Error('MIDI 메타 데이터가 손상되었습니다.');if(type===0x51&&length===3)tempos.push({tick,us:(view.getUint8(position)<<16)|(view.getUint8(position+1)<<8)|view.getUint8(position+2)});position+=length;continue}if(status===0xF0||status===0xF7){const lengthCursor={i:position},length=readVariable(view,lengthCursor);position=lengthCursor.i+length;if(position>trackEnd)throw Error('MIDI 시스템 데이터가 손상되었습니다.');continue}const kind=status&0xF0,channel=status&15;if(kind===0xC0||kind===0xD0){position++;continue}if(position+2>trackEnd)throw Error('MIDI 이벤트가 손상되었습니다.');const pitch=view.getUint8(position++),velocity=view.getUint8(position++);if(channel===9)continue;const key=`${channel}:${pitch}`;if(kind===0x90&&velocity>0){const stack=active.get(key)||[];stack.push({tick,pitch,velocity,track});active.set(key,stack)}else if(kind===0x80||(kind===0x90&&velocity===0)){const stack=active.get(key);if(stack?.length){const on=stack.shift();notes.push({...on,endTick:Math.max(tick,on.tick+1)})}}}maxTick=Math.max(maxTick,tick);for(const stack of active.values())for(const on of stack)notes.push({...on,endTick:Math.max(tick,on.tick+1)});position=trackEnd}tempos.sort((a,b)=>a.tick-b.tick);let seconds=0;const tempoPoints=tempos.map((tempo,index)=>{if(index)seconds+=(tempo.tick-tempos[index-1].tick)*tempos[index-1].us/(ticksPerBeat*1000000);return {...tempo,sec:seconds}});function tickToSeconds(tick){let low=0,high=tempoPoints.length-1;while(low<high){const mid=Math.ceil((low+high)/2);if(tempoPoints[mid].tick<=tick)low=mid;else high=mid-1}const point=tempoPoints[low];return point.sec+(tick-point.tick)*point.us/(ticksPerBeat*1000000)}const trackPitches=new Map();for(const note of notes){const pitches=trackPitches.get(note.track)||[];pitches.push(note.pitch);trackPitches.set(note.track,pitches)}const ranked=[...trackPitches].map(([track,pitches])=>({track,average:pitches.reduce((a,b)=>a+b,0)/pitches.length})).sort((a,b)=>a.average-b.average);const leftTracks=new Set(ranked.length>1?ranked.slice(0,Math.ceil(ranked.length/2)).map(item=>item.track):[]);const converted=notes.map(note=>({start:tickToSeconds(note.tick),end:tickToSeconds(note.endTick),pitch:note.pitch,velocity:note.velocity,hand:leftTracks.size?(leftTracks.has(note.track)?'left':'right'):(note.pitch<60?'left':'right')})).sort((a,b)=>a.start-b.start);return {notes:converted,tailDuration:tickToSeconds(maxTick),bpm:Math.round(60000000/(tempos.filter(item=>item.tick===0).at(-1)?.us||500000)),tempoPoints,ticksPerBeat}}
  function syncMidiMetadata(){
    const primary=midiTracks().find(track=>track.file);
    state.midiFile=primary?.file||null;
    state.tempoPoints=primary?.tempoPoints||[];
    state.ticksPerBeat=primary?.ticksPerBeat||480;
    state.midiTailDuration=Math.max(0,...midiTracks().map(track=>track.tailDuration||0));
    if(!state.originalBpmManual)state.originalBpm=primary?.bpm||null;
    if(!state.gridBpmManual)state.gridBpm=state.originalBpm||120;
    applyPlaybackSpeed();
  }
  async function loadMidi(file,trackId,hand){
    const track=trackById(trackId);if(!track||track.type!=='midi')return;
    if(!/\.(mid|midi)$/i.test(file.name)){toast('MIDI(.mid 또는 .midi) 파일을 선택해 주세요.');return}
    try{
      const parsed=parseMidi(await file.arrayBuffer());
      pause();
      state.notes=state.notes.filter(note=>note.sourceTrack!==trackId);
      state.notes.push(...parsed.notes.map(note=>({...note,hand:hand||note.hand,id:state.nextId++,sourceTrack:trackId})));
      Object.assign(track,{file,tailDuration:parsed.tailDuration,bpm:parsed.bpm,tempoPoints:parsed.tempoPoints,ticksPerBeat:parsed.ticksPerBeat});
      state.selectedTrack=trackId;
      state.selectedNoteId=null;
      state.history=[];
      syncMidiMetadata();recalculateMidiDuration();
      el.midiInput.value='';state.fileTarget=null;
      if(state.position>duration())state.position=0;
      refreshSummary();
      toast(`MIDI · ${parsed.notes.length.toLocaleString('ko-KR')}개 음표를 불러왔습니다.`);
    }catch(error){toast(error.message||'MIDI 파일을 읽지 못했습니다.')}
  }
  function recalculateMidiDuration(){state.notes.sort((a,b)=>a.start-b.start||a.pitch-b.pitch);state.midiDuration=state.notes.reduce((max,note)=>Math.max(max,note.end),state.midiTailDuration)}
  function pushHistory(){state.history.push({notes:state.notes.map(note=>({...note})),selected:state.selectedNoteId,track:state.selectedTrack});if(state.history.length>20)state.history.shift()}
  function editNotes(change){pushHistory();change();recalculateMidiDuration();state.nextNote=noteIndexAt(state.position);refreshSummary();renderEditor()}
  function transpose(amount){if(!state.midiFile)return;if(state.notes.some(note=>note.pitch+amount<0||note.pitch+amount>127)){toast('MIDI 음역 범위를 벗어나 조옮김할 수 없습니다.');return}editNotes(()=>state.notes.forEach(note=>note.pitch+=amount));updateSelectedInfo();toast(amount>0?'전체 음을 반음 높였습니다.':'전체 음을 반음 낮췄습니다.')}
  function undoMidi(){const previous=state.history.pop();if(!previous){toast('되돌릴 편집이 없습니다.');return}state.notes=previous.notes;state.selectedNoteId=previous.selected;state.selectedTrack=previous.track;recalculateMidiDuration();refreshSummary();renderEditor();toast('마지막 편집을 되돌렸습니다.')}

  function variableBytes(value){let buffer=value&127;const bytes=[];while((value>>=7)>0){buffer<<=8;buffer|=((value&127)|128)}while(true){bytes.push(buffer&255);if(buffer&128)buffer>>=8;else break}return bytes}
  function chunk(type,body){const length=body.length;return [...type.split('').map(char=>char.charCodeAt(0)),(length>>>24)&255,(length>>>16)&255,(length>>>8)&255,length&255,...body]}
  function secondsToTick(seconds){const points=state.tempoPoints;let index=0;for(let i=1;i<points.length&&points[i].sec<=seconds;i++)index=i;const point=points[index]||{sec:0,tick:0,us:500000};return Math.max(0,Math.round(point.tick+(seconds-point.sec)*state.ticksPerBeat*1000000/point.us))}
  function midiTrack(events){events.sort((a,b)=>a.tick-b.tick||a.order-b.order);let previous=0,body=[];for(const event of events){body.push(...variableBytes(event.tick-previous),...event.bytes);previous=event.tick}body.push(0,0xFF,0x2F,0);return chunk('MTrk',body)}
  function exportMidi(){
    if(!state.midiFile)return;
    const tempoByTick=new Map();for(const point of state.tempoPoints)tempoByTick.set(point.tick,point.us);
    const tempoEvents=[...tempoByTick].map(([tick,us])=>({tick,order:0,bytes:[0xFF,0x51,3,(us>>>16)&255,(us>>>8)&255,us&255]}));
    const tracks=midiTracks().filter(track=>track.file);
    const bodies=tracks.map((track,index)=>{
      const channel=index%15>=9?index%15+1:index%15,events=[{tick:0,order:0,bytes:[0xC0|channel,0]}];
      for(const note of state.notes.filter(item=>item.sourceTrack===track.id)){
        const start=secondsToTick(note.start),end=Math.max(start+1,secondsToTick(note.end));
        events.push({tick:start,order:2,bytes:[0x90|channel,note.pitch,clamp(Math.round(note.velocity),1,127)]},{tick:end,order:1,bytes:[0x80|channel,note.pitch,0]});
      }
      return midiTrack(events);
    });
    const count=bodies.length+1,header=chunk('MThd',[0,1,(count>>>8)&255,count&255,(state.ticksPerBeat>>>8)&255,state.ticksPerBeat&255]);
    const bytes=new Uint8Array([...header,...midiTrack(tempoEvents),...bodies.flat()]);
    const url=URL.createObjectURL(new Blob([bytes],{type:'audio/midi'})),link=document.createElement('a');link.href=url;link.download=(state.midiFile.name.replace(/\.(mid|midi)$/i,'')||'keyboard')+'-edited.mid';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('편집한 MIDI를 다운로드했습니다.');
  }

  function renderPerformanceStatus(){
    const count=state.performanceNotes.length;
    el.recordPerformance.disabled=!(state.midiInput||state.computerKeyboardOn)||(!duration()&&!state.recording);
    el.recordPerformance.setAttribute('aria-pressed',String(state.recording));
    el.recordPerformance.textContent=state.recording?'■ 기록 끝내기':'● 연주 기록';
    el.clearPerformance.disabled=!count||state.recording;
    el.downloadPerformance.disabled=!count||state.recording;
    el.performanceStatus.textContent=state.recording?`기록 중 · ${count}개 음표 (재생을 멈추면 기록도 멈춥니다)`:count?`${count}개 음표 기록됨 · 주황색으로 가이드와 겹쳐 표시`:'재생 중 연주를 기록하면 가이드 위에 주황색으로 표시됩니다.';
  }
  function finishRecordedNote(key,end){
    const note=state.recordingNotes.get(key);if(!note)return;
    state.recordingNotes.delete(key);
    state.performanceNotes.push({...note,end:Math.max(note.start+.01,end)});
    if(state.performanceNotes.length>10000)state.performanceNotes.shift();
    renderPerformanceStatus();renderPracticeOverview();drawViews();
  }
  function finishRecordingNotes(end){for(const key of [...state.recordingNotes.keys()])finishRecordedNote(key,end)}
  function startHeldRecording(){for(const [key,note] of state.heldNotes)state.recordingNotes.set(key,{start:currentPosition(),pitch:note.pitch,velocity:note.velocity})}
  function stopRecording(end=currentPosition()){
    if(!state.recording)return;
    finishRecordingNotes(end);state.recording=false;renderPerformanceStatus();
  }
  async function toggleRecording(){
    if(state.recording){stopRecording();return}
    if(!state.midiInput&&!state.computerKeyboardOn){toast('먼저 MIDI 장치를 연결하거나 키보드 연주를 켜세요.');return}
    if(!duration()){toast('기록을 위해 원곡 오디오 또는 가이드 MIDI를 추가하세요.');return}
    if(!state.playing)await play();
    if(!state.playing)return;
    state.recording=true;startHeldRecording();renderPerformanceStatus();
  }
  function renderLiveNotes(){
    const notes=[...state.heldNotes.values()].sort((a,b)=>a.pitch-b.pitch);
    el.liveNotes.replaceChildren();
    if(!notes.length){const empty=document.createElement('span');empty.className='midi-live-empty';empty.textContent='건반을 누르면 음이 표시됩니다.';el.liveNotes.appendChild(empty)}
    else for(const note of notes){const chip=document.createElement('span');chip.className='midi-live-note';chip.textContent=noteName(note.pitch);el.liveNotes.appendChild(chip)}
    el.liveNoteText.textContent=notes.length?`누르는 음: ${notes.map(note=>noteName(note.pitch)).join(', ')}`:'누르는 음 없음';
    renderComputerKeyboard();
    drawViews();
  }
  function releaseHeldNotes(prefix){
    for(const [key,note] of [...state.heldNotes])if(key.startsWith(prefix)){
      state.heldNotes.delete(key);finishRecordedNote(key,currentPosition());releaseLivePitch(note.pitch);
    }
    renderLiveNotes();
  }
  function releaseLivePitch(pitch){
    if(![...state.heldNotes.values()].some(note=>note.pitch===pitch))state.livePiano?.triggerRelease(pianoNote(pitch),Tone.immediate());
  }
  function pressLiveNote(key,pitch,velocity){
    finishRecordedNote(key,currentPosition());
    if(state.heldNotes.has(key))state.livePiano?.triggerRelease(pianoNote(pitch),Tone.immediate());
    state.heldNotes.set(key,{pitch,velocity});
    state.livePiano?.triggerAttack(pianoNote(pitch),Tone.immediate(),clamp(velocity/127,.05,1));
    if(state.recording&&state.playing)state.recordingNotes.set(key,{start:currentPosition(),pitch,velocity});
    renderLiveNotes();
  }
  function liftLiveNote(key){
    const note=state.heldNotes.get(key);if(!note)return;
    state.heldNotes.delete(key);finishRecordedNote(key,currentPosition());releaseLivePitch(note.pitch);renderLiveNotes();
  }
  function handleMidiMessage(event){
    const data=event.data;if(!data||data.length<2)return;
    const command=data[0]&0xF0,channel=data[0]&0x0F,pitch=data[1],velocity=data[2]||0;
    if((command===0x90||command===0x80)&&data.length>=3&&pitch<=127){
      const key=`midi:${channel}:${pitch}`;
      if(command===0x90&&velocity>0)pressLiveNote(key,pitch,velocity);
      else liftLiveNote(key);
    }else if(command===0xB0&&(pitch===120||pitch===123)){
      releaseHeldNotes(`midi:${channel}:`);
    }
  }
  function buildComputerKeyboard(){
    for(const [index,code] of computerWhiteKeys.entries()){
      const white=document.createElement('div');white.className='computer-piano-key white';white.dataset.code=code;
      const label=document.createElement('span');label.className='computer-key-label';label.textContent=code.slice(3);white.appendChild(label);
      const note=document.createElement('small');note.className='computer-note-label';white.appendChild(note);
      for(const [blackCode,[position]] of computerBlackKeys)if(position===index){
        const black=document.createElement('div');black.className='computer-piano-key black';black.dataset.code=blackCode;
        const blackLabel=document.createElement('span');blackLabel.textContent=blackCode.slice(3);black.appendChild(blackLabel);
        white.appendChild(black);
      }
      el.computerKeyboardLayout.appendChild(white);
    }
    renderComputerKeyboard();
  }
  function renderComputerKeyboard(){
    for(const key of el.computerKeyboardLayout.querySelectorAll('[data-code]')){
      const pitch=state.computerBase+computerNoteOffsets.get(key.dataset.code);
      key.classList.toggle('active',[...state.heldNotes.values()].some(note=>note.pitch===pitch));
      key.setAttribute('title',`${key.dataset.code.replace('Key','')} · ${pianoNote(pitch)}`);
      if(key.classList.contains('white'))key.querySelector('.computer-note-label').textContent=pianoNote(pitch);
    }
    el.toggleComputerKeyboard.setAttribute('aria-pressed',String(state.computerKeyboardOn));
    el.toggleComputerKeyboard.textContent=state.computerKeyboardOn?'키보드 연주 끄기':'키보드 연주 켜기';
    el.computerKeyboardStatus.textContent=state.computerKeyboardOn?`켜짐 · A = ${pianoNote(state.computerBase)} · 세기 ${state.computerVelocity}`:'꺼짐 · MIDI 장치 없이 연주할 수 있습니다.';
    el.computerKeyboardLayout.classList.toggle('enabled',state.computerKeyboardOn);
  }
  async function toggleComputerKeyboard(){
    if(state.computerKeyboardOn){
      state.computerKeyboardOn=false;releaseHeldNotes('keyboard:');
      if(!state.midiInput)stopRecording();
      renderComputerKeyboard();refreshSummary();return;
    }
    el.toggleComputerKeyboard.disabled=true;el.computerKeyboardStatus.textContent='피아노 음원 불러오는 중…';
    try{
      await preparePiano();
      if(!state.livePiano)state.livePiano=createPiano();
      state.computerKeyboardOn=true;renderComputerKeyboard();refreshSummary();
    }catch(error){el.computerKeyboardStatus.textContent='음원을 불러오지 못했습니다. 다시 시도해 주세요.';toast('피아노 음원을 불러오지 못했습니다. 네트워크를 확인하세요.')}
    finally{el.toggleComputerKeyboard.disabled=false}
  }
  function handleComputerKeyDown(event){
    if(!state.computerKeyboardOn||event.metaKey||event.ctrlKey||event.altKey)return;
    if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)||document.activeElement?.isContentEditable)return;
    if([...document.querySelectorAll('.overlay,.modal-overlay')].some(item=>!item.classList.contains('hidden')&&item.id!=='viewOverlay'))return;
    const code=event.code;
    if(computerNoteOffsets.has(code)){
      event.preventDefault();if(event.repeat||state.heldNotes.has(`keyboard:${code}`))return;
      pressLiveNote(`keyboard:${code}`,state.computerBase+computerNoteOffsets.get(code),state.computerVelocity);
    }else if(['KeyZ','KeyX','KeyC','KeyV'].includes(code)){
      event.preventDefault();if(event.repeat)return;
      if(code==='KeyZ'||code==='KeyX'){
        releaseHeldNotes('keyboard:');state.computerBase=clamp(state.computerBase+(code==='KeyZ'?-12:12),36,84);
      }else state.computerVelocity=clamp(state.computerVelocity+(code==='KeyC'?-10:10),20,127);
      renderComputerKeyboard();
    }
  }
  function handleComputerKeyUp(event){
    const key=`keyboard:${event.code}`;
    if(!state.heldNotes.has(key))return;
    event.preventDefault();liftLiveNote(key);
  }
  function selectMidiInput(id){
    const input=[...state.midiAccess.inputs.values()].find(item=>item.id===id&&item.state==='connected')||null;
    if(state.midiInput===input){if(!input){el.midiStatus.textContent='입력 장치를 찾지 못했습니다. USB 연결과 전원을 확인하세요.';refreshSummary()}return}
    if(!state.computerKeyboardOn)stopRecording();releaseHeldNotes('midi:');
    if(state.midiInput)state.midiInput.removeEventListener('midimessage',handleMidiMessage);
    state.midiInput=input;state.midiInputId=input?.id||'';
    if(input&&!state.livePiano)state.livePiano=createPiano();
    if(input)input.addEventListener('midimessage',handleMidiMessage);
    el.midiDevice.value=state.midiInputId;
    el.midiStatus.textContent=input?`연결됨 · ${input.name||'MIDI 입력'} (입력 음은 서버로 전송되지 않습니다)`:'입력 장치를 찾지 못했습니다. USB 연결과 전원을 확인하세요.';
    renderPerformanceStatus();refreshSummary();
  }
  function refreshMidiDevices(){
    const inputs=[...state.midiAccess.inputs.values()].filter(input=>input.state==='connected');
    const preferred=inputs.find(input=>input.id===state.midiInputId)||inputs[0];
    el.midiDevice.replaceChildren();
    if(!inputs.length){const option=document.createElement('option');option.value='';option.textContent='연결된 장치 없음';el.midiDevice.appendChild(option)}
    else for(const input of inputs){const option=document.createElement('option');option.value=input.id;option.textContent=input.name||`MIDI 입력 ${el.midiDevice.options.length+1}`;el.midiDevice.appendChild(option)}
    el.midiDevice.disabled=!inputs.length;
    el.midiDevice.value=preferred?.id||'';
    selectMidiInput(preferred?.id||'');
  }
  async function connectMidi(){
    if(!navigator.requestMIDIAccess||!window.isSecureContext){el.midiStatus.textContent='Web MIDI를 지원하는 브라우저에서 localhost 또는 HTTPS로 열어 주세요.';return}
    el.connectMidi.disabled=true;el.midiStatus.textContent='MIDI 장치 접근 권한 요청 중…';
    try{
      const [access]=await Promise.all([state.midiAccess||navigator.requestMIDIAccess({sysex:false}),preparePiano()]);
      if(!state.midiAccess){state.midiAccess=access;state.midiAccess.addEventListener('statechange',refreshMidiDevices)}
      refreshMidiDevices();el.connectMidi.textContent='장치 다시 찾기';
    }catch(error){el.midiStatus.textContent=error?.name==='SecurityError'||error?.name==='NotAllowedError'?'MIDI 권한이 거부되었습니다. 브라우저 사이트 권한을 확인하세요.':error?.message?.includes('Tone.js')||error?.message?.includes('fetch')?'피아노 음원을 불러오지 못했습니다. 페이지를 새로고침해 주세요.':'MIDI 장치 또는 피아노 음원을 연결할 수 없습니다. 브라우저와 USB 연결을 확인하세요.'}
    finally{el.connectMidi.disabled=false}
  }
  function downloadPerformance(){
    if(!state.performanceNotes.length)return;
    const tempos=new Map();for(const point of state.tempoPoints)tempos.set(point.tick,point.us);
    if(!tempos.size)tempos.set(0,500000);
    const tempoEvents=[...tempos].map(([tick,us])=>({tick,order:0,bytes:[0xFF,0x51,3,(us>>>16)&255,(us>>>8)&255,us&255]}));
    const events=[{tick:0,order:0,bytes:[0xC0,0]}];
    for(const note of state.performanceNotes){const start=secondsToTick(note.start),end=Math.max(start+1,secondsToTick(note.end));events.push({tick:start,order:2,bytes:[0x90,note.pitch,clamp(note.velocity,1,127)]},{tick:end,order:1,bytes:[0x80,note.pitch,0]})}
    const count=2,header=chunk('MThd',[0,1,0,count,(state.ticksPerBeat>>>8)&255,state.ticksPerBeat&255]);
    const bytes=new Uint8Array([...header,...midiTrack(tempoEvents),...midiTrack(events)]);
    const url=URL.createObjectURL(new Blob([bytes],{type:'audio/midi'})),link=document.createElement('a');link.href=url;link.download='my-performance.mid';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  function sizeCanvas(canvas){const box=canvas.getBoundingClientRect();if(!box.width||!box.height)return null;const ratio=Math.min(window.devicePixelRatio||1,2),width=Math.round(box.width*ratio),height=Math.round(box.height*ratio);if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height}const ctx=canvas.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);return {ctx,width:box.width,height:box.height}}
  function drawWave(track){const canvas=sizeCanvas(track.wave);if(!canvas)return;const {ctx,width,height}=canvas;ctx.clearRect(0,0,width,height);if(!track.file)return;const available=duration(),totalAudio=audioLength(track),trackWidth=available?width*totalAudio/available:width,startX=available?width*(track.leadIn||0)/available:0,peaks=track.wavePeaks;if(!peaks){ctx.fillStyle='#b88468';ctx.fillRect(startX,height/2,trackWidth,2);return}const trimIndex=Math.floor(track.trimStart/track.sourceDuration*peaks.length),visible=peaks.length-trimIndex;ctx.fillStyle='#bfe5b7';for(let i=trimIndex;i<peaks.length;i++){const x=startX+(i-trimIndex)*trackWidth/visible,bar=Math.max(2,peaks[i]*(height-26));ctx.globalAlpha=.6+peaks[i]*.4;ctx.fillRect(x,height/2-bar/2,Math.max(1,trackWidth/visible*.75),bar)}ctx.globalAlpha=1}
  function drawTrimWave(){const track=trackById(state.selectedAudioTrack),canvas=sizeCanvas(el.trimWave);if(!canvas)return;const {ctx,width,height}=canvas;ctx.clearRect(0,0,width,height);ctx.fillStyle='#233126';ctx.fillRect(0,0,width,height);const peaks=track?.wavePeaks;if(peaks){ctx.fillStyle='#addb9b';for(let i=0;i<peaks.length;i++){const x=i*width/peaks.length,bar=Math.max(2,peaks[i]*(height-20));ctx.fillRect(x,height/2-bar/2,Math.max(1,width/peaks.length*.8),bar)}}else{ctx.fillStyle='#759579';ctx.fillRect(0,height/2,width,2)}const marker=track?.sourceDuration?track.trimStart/track.sourceDuration*width:0;ctx.fillStyle='#0d110dbb';ctx.fillRect(0,0,marker,height);ctx.fillStyle='#e7b788';ctx.fillRect(marker-1,0,2,height)}
  function drawMidiOverview(){
    const total=Math.max(duration(),.01);
    for(const track of midiTracks()){
      const container=track.overview;
      container.replaceChildren();
      if(!track.file)continue;
      const notes=state.notes.filter(note=>note.sourceTrack===track.id),fragment=document.createDocumentFragment();
      const limit=Math.min(notes.length,1800),step=Math.max(1,Math.floor(notes.length/Math.max(1,limit)));
      let minimum=127,maximum=0;
      for(const note of notes){minimum=Math.min(minimum,note.pitch);maximum=Math.max(maximum,note.pitch)}
      if(maximum===minimum)maximum=minimum+1;
      for(let i=0;i<notes.length;i+=step){
        const note=notes[i],item=document.createElement('i');
        item.className='mini-note';
        item.style.left=`${note.start/total*100}%`;
        item.style.width=`${Math.max(.25,(note.end-note.start)/total*100)}%`;
        item.style.top=`${12+(maximum-note.pitch)/(maximum-minimum)*75}%`;
        fragment.appendChild(item);
      }
      container.appendChild(fragment);
    }
  }

  function pitchRange(){const notes=[...viewNotes(),...state.performanceNotes,...state.heldNotes.values()];if(!notes.length)return {low:48,high:84};let low=127,high=0;for(const note of notes){low=Math.min(low,note.pitch);high=Math.max(high,note.pitch)}low=Math.max(0,Math.floor((low-2)/12)*12);high=Math.min(127,Math.ceil((high+3)/12)*12);if(high-low<24)high=Math.min(127,low+24);return {low,high}}
  function drawFall(){
    const guideNotes=viewNotes(),range=pitchRange(),low=Math.min(48,range.low),high=Math.max(84,range.high);
    const whitePitches=[];
    for(let pitch=low;pitch<=high;pitch++)if(!blackKeys.has(pitch%12))whitePitches.push(pitch);
    const viewportWidth=el.fall.parentElement.clientWidth;
    el.fall.style.width=`${Math.max(viewportWidth,whitePitches.length*state.fallKeyWidth)}px`;
    const canvas=sizeCanvas(el.fall);if(!canvas)return;
    const {ctx,width,height}=canvas,whiteWidth=width/whitePitches.length,blackWidth=whiteWidth*.58;
    const labelFontSize=clamp(blackWidth*.34,11,16);
    const keyHeight=clamp(height*.43,100,260),blackHeight=keyHeight*.68,hitY=height-keyHeight,scale=state.fallScale;
    const whiteIndex=new Map(whitePitches.map((pitch,index)=>[pitch,index]));
    const keyRect=pitch=>{
      if(blackKeys.has(pitch%12)){
        const previous=whiteIndex.get(pitch-1);
        return previous===undefined?null:{x:(previous+1)*whiteWidth-blackWidth/2,width:blackWidth,black:true};
      }
      const index=whiteIndex.get(pitch);
      return index===undefined?null:{x:index*whiteWidth,width:whiteWidth,black:false};
    };
    const active=new Map();
    for(const note of guideNotes){
      if(note.start>state.position||note.end<=state.position)continue;
      const colors=active.get(note.pitch)||[],color=midiColor(note.sourceTrack);
      if(!colors.includes(color))colors.push(color);
      active.set(note.pitch,colors);
    }
    el.fallNoteProgress.textContent=`${guideNotes.filter(note=>note.end<=state.position).length.toLocaleString('ko-KR')} / ${guideNotes.length.toLocaleString('ko-KR')}`;

    ctx.fillStyle='#303030';ctx.fillRect(0,0,width,hitY);
    whitePitches.forEach((pitch,index)=>{
      const x=index*whiteWidth;
      if(index%2===1){ctx.fillStyle='#2e2e2e';ctx.fillRect(x,0,whiteWidth,hitY)}
      ctx.fillStyle=pitch%12===0?'#505050':'#414141';ctx.fillRect(x,0,pitch%12===0?2:1,hitY);
    });
    const barSeconds=240/(state.gridBpm||120),firstBar=Math.floor(state.position/barSeconds)*barSeconds;
    for(let time=firstBar;time<state.position+hitY/scale;time+=barSeconds){
      const y=Math.round(hitY-(time-state.position)*scale);
      if(y>=0&&y<hitY){ctx.fillStyle='#3b3b3b';ctx.fillRect(0,y,width,1)}
    }

    ctx.save();ctx.beginPath();ctx.rect(0,0,width,hitY);ctx.clip();
    for(const note of guideNotes){
      if(note.end<state.position||note.start>state.position+hitY/scale+.5)continue;
      const key=keyRect(note.pitch);if(!key)continue;
      const noteWidth=key.width*(key.black?.94:.78),x=key.x+(key.width-noteWidth)/2;
      const bottom=hitY-(note.start-state.position)*scale;
      const noteHeight=Math.max(22,(note.end-note.start)*scale),top=bottom-noteHeight;
      if(bottom<0||top>=hitY)continue;
      ctx.beginPath();ctx.roundRect(x,top,noteWidth,noteHeight,Math.min(12,noteWidth*.2,noteHeight*.25));
      ctx.fillStyle=midiColor(note.sourceTrack);ctx.fill();
      ctx.strokeStyle='#202a2b';ctx.lineWidth=1.5;ctx.stroke();
      const visibleTop=Math.max(0,top),visibleBottom=Math.min(hitY,bottom);
      if(visibleBottom-visibleTop>=14){
        const label=names[note.pitch%12],fontSize=labelFontSize;
        ctx.font=`800 ${fontSize}px Apple SD Gothic Neo, Pretendard, sans-serif`;
        ctx.textAlign='center';ctx.textBaseline='middle';ctx.lineJoin='round';ctx.lineWidth=3;
        const labelY=clamp(bottom-fontSize*.7,visibleTop+fontSize*.55,visibleBottom-fontSize*.55);
        ctx.strokeStyle='#27302d';ctx.strokeText(label,x+noteWidth/2,labelY);
        ctx.fillStyle='#fffef2';ctx.fillText(label,x+noteWidth/2,labelY);
      }
    }
    ctx.restore();

    ctx.fillStyle='#a92e2b';ctx.fillRect(0,hitY-4,width,5);
    for(const pitch of whitePitches){
      const key=keyRect(pitch),colors=active.get(pitch)||[],selected=colors.length>0;
      ctx.fillStyle='#fffef0';ctx.fillRect(key.x+1,hitY+1,key.width-2,keyHeight);
      colors.forEach((color,index)=>{ctx.fillStyle=color;ctx.fillRect(key.x+1+index*(key.width-2)/colors.length,hitY+1,(key.width-2)/colors.length,keyHeight)});
      ctx.strokeStyle='#171717';ctx.lineWidth=1.5;ctx.strokeRect(key.x+.75,hitY+1,key.width-.5,keyHeight);
      ctx.font=`600 ${labelFontSize}px Apple SD Gothic Neo, Pretendard, sans-serif`;
      ctx.textAlign='center';ctx.textBaseline='alphabetic';ctx.fillStyle=selected?'#29302c':'#8c8c82';
      ctx.fillText(names[pitch%12],key.x+key.width/2,height-12);
    }
    for(let pitch=low;pitch<=high;pitch++){
      if(!blackKeys.has(pitch%12))continue;
      const key=keyRect(pitch);if(!key)continue;
      const colors=active.get(pitch)||[],selected=colors.length>0;
      ctx.save();ctx.shadowColor='#0009';ctx.shadowBlur=7;ctx.shadowOffsetX=3;
      ctx.beginPath();ctx.roundRect(key.x,hitY+1,key.width,blackHeight,[0,0,4,4]);
      if(selected){
        ctx.fillStyle=colors[0];ctx.fill();
        ctx.save();ctx.clip();
        colors.forEach((color,index)=>{ctx.fillStyle=color;ctx.fillRect(key.x+index*key.width/colors.length,hitY+1,key.width/colors.length,blackHeight)});
        ctx.restore();
      }else{
        const gradient=ctx.createLinearGradient(0,hitY,0,hitY+blackHeight);
        gradient.addColorStop(0,'#0d0d0d');gradient.addColorStop(.8,'#1b1b1b');gradient.addColorStop(1,'#383838');
        ctx.fillStyle=gradient;ctx.fill();
      }
      ctx.restore();
      ctx.strokeStyle='#050505';ctx.lineWidth=2;ctx.stroke();
      ctx.font=`600 ${labelFontSize}px Apple SD Gothic Neo, Pretendard, sans-serif`;
      ctx.textAlign='center';ctx.textBaseline='alphabetic';ctx.fillStyle=selected?'#29302c':'#c8c8c3';
      ctx.fillText(names[pitch%12],key.x+key.width/2,hitY+blackHeight-10);
    }
    for(const note of state.heldNotes.values()){
      const key=keyRect(note.pitch);if(!key)continue;
      const dotY=hitY+(key.black?blackHeight*.8:keyHeight*.78);
      ctx.beginPath();ctx.arc(key.x+key.width/2,dotY,Math.min(12,key.width*.2),0,Math.PI*2);
      ctx.fillStyle='#ffad72';ctx.fill();ctx.strokeStyle='#f4f8f8';ctx.lineWidth=2;ctx.stroke();
    }
  }
  function drawRoll(){
    const canvas=sizeCanvas(el.roll);if(!canvas)return;
    const {ctx,width,height}=canvas,{low,high}=pitchRange(),count=high-low+1,labelWidth=56,row=height/count,scale=70,position=currentPosition();
    ctx.clearRect(0,0,width,height);ctx.fillStyle='#1a251d';ctx.fillRect(0,0,width,height);
    for(let pitch=low;pitch<=high;pitch++){const y=(high-pitch)*row;ctx.fillStyle=blackKeys.has(pitch%12)?'#1a241d':'#263129';ctx.fillRect(0,y,width,row-1);ctx.fillStyle='#536b55';ctx.font='11px sans-serif';if(row>8)ctx.fillText(noteName(pitch),6,y+Math.min(row-2,11))}
    ctx.fillStyle='#19211b';ctx.fillRect(0,0,labelWidth,height);ctx.strokeStyle='#657766';ctx.beginPath();ctx.moveTo(labelWidth,0);ctx.lineTo(labelWidth,height);ctx.stroke();
    for(let time=Math.ceil(position);time<position+(width-labelWidth)/scale;time++){const x=labelWidth+(time-position)*scale;ctx.fillStyle='#415145';ctx.fillRect(x,0,1,height)}
    for(const note of viewNotes()){
      if(note.end<position||note.start>position+(width-labelWidth)/scale)continue;
      const x=labelWidth+(note.start-position)*scale,y=(high-note.pitch)*row+.5,noteWidth=Math.max(3,(note.end-note.start)*scale);
      ctx.fillStyle=midiColor(note.sourceTrack);ctx.fillRect(x,y,noteWidth,Math.max(3,row-1));
      if(noteWidth>38&&row>11){ctx.fillStyle='#18251c';ctx.font='bold 10px sans-serif';ctx.fillText(noteName(note.pitch),x+4,y+Math.min(row-2,10))}
    }
    for(const note of [...state.performanceNotes,...state.recordingNotes.values()].filter(item=>item.end===undefined?true:item.end>=position)){
      if(note.start>position+(width-labelWidth)/scale)continue;
      const end=note.end??position,x=labelWidth+(note.start-position)*scale,y=(high-note.pitch)*row+.5;
      ctx.fillStyle='#ffad72';ctx.fillRect(Math.max(labelWidth,x),y,Math.max(3,(end-Math.max(position,note.start))*scale),Math.max(3,row-1));
    }
    for(const note of state.heldNotes.values()){
      ctx.fillStyle='#ffd0a1';ctx.fillRect(labelWidth,(high-note.pitch)*row+.5,7,Math.max(3,row-1));
    }
  }
  function drawViews(){if(!$('viewOverlay').classList.contains('hidden')){drawFall();drawRoll()}}
  function updatePracticeTransport(){
    const total=duration(),position=clamp(state.position,0,total);
    if(state.practiceFlagTime!==null)state.practiceFlagTime=total>0?clamp(state.practiceFlagTime,0,Math.max(0,total-.01)):null;
    el.practiceTime.textContent=`${fmt(position)} / ${fmt(total)}`;
    el.practicePosition.style.left=`${total?position/total*100:0}%`;
    el.practiceScrub.setAttribute('aria-valuemax',String(Number(total.toFixed(2))));
    el.practiceScrub.setAttribute('aria-valuenow',String(Number(position.toFixed(2))));
    el.practiceScrub.setAttribute('aria-valuetext',`${fmt(position)} / ${fmt(total)}`);
    const flagRatio=state.practiceFlagTime===null||!total?0:clamp(state.practiceFlagTime/total,0,1);
    el.practiceFlag.hidden=state.practiceFlagTime===null;
    el.timelineFlag.hidden=state.practiceFlagTime===null;
    if(state.practiceFlagTime!==null){
      const flagLabel=`시작 플래그 ${fmt(state.practiceFlagTime)}. 드래그해서 이동`;
      el.practiceFlag.style.left=`${flagRatio*100}%`;el.practiceFlag.classList.toggle('near-end',flagRatio>.82);el.practiceFlag.setAttribute('aria-label',flagLabel);
      el.timelineFlag.style.left=`${flagRatio*100}%`;el.timelineFlag.classList.toggle('near-end',flagRatio>.82);el.timelineFlag.setAttribute('aria-label',flagLabel);
    }
    el.placePracticeFlag.disabled=!total;
    el.clearPracticeFlag.disabled=state.practiceFlagTime===null;
    el.placeTimelineFlag.disabled=!total;
    el.clearTimelineFlag.disabled=state.practiceFlagTime===null;
  }
  function viewMidiTracks(){return state.practiceTrackId?midiTracks().filter(track=>track.id===state.practiceTrackId):midiTracks().filter(track=>track.file)}
  function viewNotes(){const ids=new Set(viewMidiTracks().map(track=>track.id));return state.notes.filter(note=>ids.has(note.sourceTrack))}
  function renderPracticeLegends(){
    for(const legend of [$('fallLegend'),$('rollLegend')]){
      legend.replaceChildren();
      for(const track of viewMidiTracks()){
        const swatch=document.createElement('i');swatch.style.backgroundColor=midiColor(track.id);
        legend.append(swatch,document.createTextNode(` ${track.label.textContent} `));
      }
      const played=document.createElement('i');played.className='legend-played';
      legend.append(played,document.createTextNode(' 내 연주'));
    }
  }
  function renderPracticeTrackPicker(){
    if(!el.practiceTrackPicker){
      const picker=document.createElement('div');picker.id='practiceTrackPicker';picker.className='practice-track-picker';picker.setAttribute('aria-label','보고 칠 MIDI 트랙 선택');$('viewOverlay').querySelector('.tabs').before(picker);el.practiceTrackPicker=picker;
    }
    const tracks=midiTracks().filter(track=>track.file);
    if(state.practiceTrackId&&!tracks.some(track=>track.id===state.practiceTrackId))state.practiceTrackId=null;
    el.fallSpeedLabel.textContent=`${(state.fallScale/56).toFixed(1)}×`;
    el.fallSpeedLabel.nextElementSibling.textContent='스크롤: 위치 · ⌘+스크롤: 속도 · ⌥+스크롤: 가로 확대';
    el.practiceTrackPicker.replaceChildren();
    const choices=[{id:null,label:'전체 MIDI'},...tracks.map(track=>({id:track.id,label:track.label.textContent}))];
    for(const choice of choices){
      const button=document.createElement('button');button.type='button';button.className='practice-track-button';button.textContent=choice.label;button.classList.toggle('active',choice.id===state.practiceTrackId);button.setAttribute('aria-pressed',String(choice.id===state.practiceTrackId));
      if(choice.id)button.style.setProperty('--midi-color',midiColor(choice.id));
      button.addEventListener('click',()=>{state.practiceTrackId=choice.id;renderPracticeTrackPicker();renderPracticeOverview();drawViews();refreshSummary()});
      el.practiceTrackPicker.appendChild(button);
    }
    renderPracticeLegends();
  }
  function renderPracticeOverview(){
    const total=Math.max(duration(),.01),notes=[...viewNotes(),...state.performanceNotes],container=el.practiceMidiNotes;
    container.replaceChildren();el.practiceScrubEmpty.classList.toggle('hidden',notes.length>0);
    drawBeatGrid(el.practiceBeatGrid,0,total,el.practiceScrub.clientWidth);
    if(!notes.length){updatePracticeTransport();return}
    let low=127,high=0;for(const note of notes){low=Math.min(low,note.pitch);high=Math.max(high,note.pitch)}
    const mid=(low+high)/2;low=Math.max(0,Math.min(low,mid-12));high=Math.min(127,Math.max(high,mid+12));
    const fragment=document.createDocumentFragment(),performed=new Set(state.performanceNotes),limit=1800,step=Math.max(1,Math.ceil(notes.length/limit));
    for(let i=0;i<notes.length;i+=step){
      const note=notes[i],bar=document.createElement('i');bar.className='practice-note'+(performed.has(note)?' performed':'');
      if(!performed.has(note))bar.style.setProperty('--midi-color',midiColor(note.sourceTrack));
      bar.style.left=`${note.start/total*100}%`;bar.style.width=`${Math.max(.18,(note.end-note.start)/total*100)}%`;
      bar.style.top=`${8+(high-note.pitch)/Math.max(1,high-low)*78}%`;fragment.appendChild(bar);
    }
    container.appendChild(fragment);updatePracticeTransport();
  }
  function practiceTimeFromPointer(event){const box=el.practiceScrub.getBoundingClientRect();return box.width?clamp((event.clientX-box.left)/box.width,0,1)*duration():0}
  function timelineFlagTimeFromPointer(event){const box=el.timelineFlagLayer.getBoundingClientRect();return box.width?clamp((event.clientX-box.left)/box.width,0,1)*duration():0}
  function setPracticeFlag(time){if(!duration()){toast('먼저 오디오 또는 MIDI 파일을 추가하세요.');return}state.practiceFlagTime=clamp(time,0,Math.max(0,duration()-.01));updatePracticeTransport()}
  function startPracticeDrag(event,type){if(event.button!==0||!duration())return;event.preventDefault();event.stopPropagation();state.practiceDrag={type,pointerId:event.pointerId};el.practiceScrub.setPointerCapture(event.pointerId);if(type==='flag')setPracticeFlag(practiceTimeFromPointer(event));else seek(practiceTimeFromPointer(event))}
  function movePracticeDrag(event){if(!state.practiceDrag||state.practiceDrag.pointerId!==event.pointerId)return;if(state.practiceDrag.type==='flag')setPracticeFlag(practiceTimeFromPointer(event));else seek(practiceTimeFromPointer(event))}
  function endPracticeDrag(event){if(!state.practiceDrag||state.practiceDrag.pointerId!==event.pointerId)return;state.practiceDrag=null;if(el.practiceScrub.hasPointerCapture?.(event.pointerId))el.practiceScrub.releasePointerCapture(event.pointerId)}
  function startTimelineFlagDrag(event){if(event.button!==0||!duration())return;event.preventDefault();event.stopPropagation();state.practiceDrag={type:'timeline-flag',pointerId:event.pointerId};el.timelineFlag.setPointerCapture(event.pointerId);setPracticeFlag(timelineFlagTimeFromPointer(event))}
  function moveTimelineFlagDrag(event){if(!state.practiceDrag||state.practiceDrag.type!=='timeline-flag'||state.practiceDrag.pointerId!==event.pointerId)return;setPracticeFlag(timelineFlagTimeFromPointer(event))}
  function endTimelineFlagDrag(event){if(!state.practiceDrag||state.practiceDrag.type!=='timeline-flag'||state.practiceDrag.pointerId!==event.pointerId)return;state.practiceDrag=null;if(el.timelineFlag.hasPointerCapture?.(event.pointerId))el.timelineFlag.releasePointerCapture(event.pointerId)}
  function secondsToBeat(seconds){
    if(!state.tempoPoints.length)return seconds*(state.originalBpm||120)/60;
    let point=state.tempoPoints[0];for(const next of state.tempoPoints){if(next.sec>seconds)break;point=next}
    return (point.tick+(seconds-point.sec)*state.ticksPerBeat*1000000/point.us)/state.ticksPerBeat;
  }
  function beatToSeconds(beat){
    if(!state.tempoPoints.length)return beat*60/(state.originalBpm||120);
    const tick=beat*state.ticksPerBeat;let point=state.tempoPoints[0];for(const next of state.tempoPoints){if(next.tick>tick)break;point=next}
    return point.sec+(tick-point.tick)*point.us/(state.ticksPerBeat*1000000);
  }
  function beatGridStep(view,width){const beatPixels=width/view*60/(state.originalBpm||120);return [.25,.5,1,2,4,8,16,32,64,128].find(step=>beatPixels*step>=12)||128}
  function drawBeatGrid(container,start,view,width,labels){
    container.replaceChildren();if(!width||!view)return;
    const step=beatGridStep(view,width),first=Math.ceil((secondsToBeat(start)-.000001)/step)*step;
    for(let beat=first,count=0;count<600;beat+=step,count++){
      const time=beatToSeconds(beat);if(time>start+view+.000001)break;if(time<start-.000001)continue;
      const bar=Math.abs(beat/4-Math.round(beat/4))<.00001,whole=Math.abs(beat-Math.round(beat))<.00001;
      const line=document.createElement('i');line.className='beat-line'+(bar?' bar':whole?' beat':'');line.style.left=`${(time-start)/view*100}%`;container.appendChild(line);
      const beatPixels=width/view*60/(state.originalBpm||120);
      const labelEvery=Math.max(1,Math.ceil(42/(beatPixels*step)));
      if(labels&&(bar||whole&&step<=1&&beatPixels>46)&&count%labelEvery===0){
        const mark=document.createElement('span');mark.className='beat-label';mark.style.left=line.style.left;mark.textContent=`${Math.floor(beat/4)+1}.${Math.floor(beat%4)+1}`;labels.appendChild(mark);
      }
    }
  }
  function renderRuler(){const total=duration()||16;el.ruler.replaceChildren();drawBeatGrid(el.ruler,0,total,el.ruler.clientWidth,el.ruler)}
  function drawTimelineGrid(){const total=duration()||16;for(const track of state.tracks)drawBeatGrid(track.grid,0,total,track.lane.clientWidth)}
  function createTrack(type){
    const id=`track-${state.nextTrackId++}`,track={id,type,file:null,muted:false,volume:1,trimStart:0,leadIn:0,pitch:0,sourceDuration:0,wavePeaks:null,tailDuration:0};
    const head=document.createElement('div'),lane=document.createElement('div');head.className='track-head';lane.className=`track-lane ${type}-lane drop-target`;lane.tabIndex=0;lane.setAttribute('role','button');
    head.innerHTML=`<span class="track-icon ${type}-icon">${type==='audio'?'♫':'▦'}</span><span class="track-label"><strong></strong><small>${type==='audio'?'MP3 · WAV':'.mid · .midi'}</small></span><label class="track-volume" title="트랙 볼륨"><span>볼륨</span><input type="range" min="0" max="1" step="0.01" value="1" aria-label="트랙 볼륨"></label><button class="track-mute" type="button" aria-pressed="false" aria-label="음소거">M</button><button class="track-remove" type="button" aria-label="트랙 제거" title="트랙 제거">×</button>`;
    lane.innerHTML=`<div class="track-grid"></div><div class="track-empty"><span class="empty-plus">＋</span><span>${type==='audio'?'오디오':'MIDI'} 파일을 놓으세요</span><small>${type==='audio'?'MP3 또는 WAV':'.mid 또는 .midi'}</small></div>${type==='audio'?'<canvas class="waveform" aria-hidden="true"></canvas>':'<div class="midi-overview" aria-hidden="true"></div>'}<a class="clip-name" download></a><div class="playhead" aria-hidden="true"></div>`;
    Object.assign(track,{head,lane,label:head.querySelector('strong'),mute:head.querySelector('.track-mute'),volumeInput:head.querySelector('.track-volume input'),grid:lane.querySelector('.track-grid'),clipName:lane.querySelector('.clip-name'),wave:lane.querySelector('canvas'),overview:lane.querySelector('.midi-overview')});
    track.clipName.addEventListener('click',event=>event.stopPropagation());
    track.clipName.addEventListener('keydown',event=>event.stopPropagation());
    if(type==='audio'){
      track.audio=document.createElement('audio');track.audio.preload='metadata';
      track.audio.preservesPitch=true;
      track.audio.addEventListener('loadedmetadata',()=>{if(!track.file)return;track.sourceDuration=Number.isFinite(track.audio.duration)?track.audio.duration:0;track.trimStart=clamp(track.trimStart,0,Math.max(0,track.sourceDuration-.1));refreshSummary()});
      track.audio.addEventListener('error',()=>{if(track.file)toast(`${track.file.name} 오디오를 재생할 수 없습니다.`)});
    }
    track.mute.addEventListener('click',()=>{track.muted=!track.muted;track.mute.setAttribute('aria-pressed',String(track.muted));if(type==='audio')setTrackVolume(track);else if(track.muted)stopTrackNotes(track.id)});
    track.volumeInput.addEventListener('input',event=>{track.volume=Number(event.target.value);setTrackVolume(track)});
    head.querySelector('.track-remove').addEventListener('click',()=>removeTrack(id));
    connectDropZone(lane,track);
    state.tracks.push(track);el.trackRows.append(head,lane);renumberTracks();refreshSummary();return track;
  }
  function renumberTracks(){const counts={audio:0,midi:0};for(const track of state.tracks){track.label.textContent=`${track.type==='audio'?'오디오':'MIDI'} ${++counts[track.type]}`;track.lane.setAttribute('aria-label',`${track.label.textContent} 파일 추가 또는 편집`);track.mute.setAttribute('aria-label',`${track.label.textContent} 음소거`);if(track.type==='midi'){const color=midiColor(track.id);track.head.style.setProperty('--midi-color',color);track.lane.style.setProperty('--midi-color',color)}}}
  function removeTrack(id){
    const track=trackById(id);if(!track)return;pause();
    if(track.sourceDownloadUrl)URL.revokeObjectURL(track.sourceDownloadUrl);
    if(track.type==='audio'){track.audio.pause();disconnectAudioPitch(track);track.audio.removeAttribute('src');track.audio.load();if(track.url)URL.revokeObjectURL(track.url);if(state.selectedAudioTrack===id){state.selectedAudioTrack=null;closeModal('audioEditOverlay')}}
    else{track.piano?.dispose();state.notes=state.notes.filter(note=>note.sourceTrack!==id);state.history=[];if(state.selectedTrack===id){state.selectedTrack=null;closeModal('midiEditOverlay')}}
    track.head.remove();track.lane.remove();state.tracks=state.tracks.filter(item=>item!==track);syncMidiMetadata();recalculateMidiDuration();state.position=clamp(state.position,0,duration());renumberTracks();refreshSummary();
  }
  function refreshSummary(){
    const parts=[];
    for(const track of state.tracks){
      track.lane.classList.toggle('has-file',!!track.file);
      if(track.downloadFile!==track.file){
        if(track.sourceDownloadUrl)URL.revokeObjectURL(track.sourceDownloadUrl);
        track.sourceDownloadUrl=track.file?URL.createObjectURL(track.file):null;
        track.downloadFile=track.file;
      }
      track.clipName.textContent=track.file?.name||'';
      track.clipName.download=track.file?.name||'';
      if(track.sourceDownloadUrl)track.clipName.href=track.sourceDownloadUrl;
      else track.clipName.removeAttribute('href');
      if(track.file)parts.push(`${track.label.textContent} ${track.file.name}${track.type==='audio'&&track.pitch?` · 조 ${track.pitch>0?'+':''}${track.pitch}반음`:''}${track.type==='audio'&&track.trimStart?` · 앞 ${track.trimStart.toFixed(2)}초 자름`:''}${track.type==='audio'&&track.leadIn?` · 앞 ${track.leadIn.toFixed(2)}초 공백`:''}`);
    }
    el.summary.textContent=parts.length?parts.join(' / '):'오디오와 MIDI를 추가하면 함께 재생됩니다.';
    el.noteCount.textContent=state.midiFile?`${viewNotes().length.toLocaleString('ko-KR')}개 음표`:'MIDI 대기 중';
    el.fallEmpty.classList.toggle('hidden',!!state.midiFile||!!state.midiInput||state.computerKeyboardOn||!!state.performanceNotes.length);
    el.rollEmpty.classList.toggle('hidden',!!state.midiFile||!!state.midiInput||state.computerKeyboardOn||!!state.performanceNotes.length);
    renderPracticeTrackPicker();
    el.originalBpm.value=state.originalBpm===null?'':String(state.originalBpm);
    el.bpm.value=String(state.gridBpm);
    updateTransport();renderRuler();drawTimelineGrid();for(const track of audioTracks())drawWave(track);drawMidiOverview();renderPracticeOverview();drawViews();updateTrimControls();renderPerformanceStatus();
  }


  function openModal(id,focusId){state.lastFocus=document.activeElement;document.querySelectorAll('.overlay,.modal-overlay').forEach(item=>item.classList.add('hidden'));$(id).classList.remove('hidden');document.body.classList.add('modal-open');requestAnimationFrame(()=>{if(focusId)$(focusId).focus();if(id==='viewOverlay')renderPracticeOverview();drawViews();drawTrimWave()})}
  function closeModal(id){$(id).classList.add('hidden');document.body.classList.remove('modal-open');state.lastFocus?.focus?.()}
  function openAudioEditor(id){const track=trackById(id)||audioTracks().find(item=>item.file);if(!track){const empty=audioTracks()[0]||createTrack('audio');openTrackFile(empty);return}if(!track.file){openTrackFile(track);return}pause();state.selectedAudioTrack=track.id;openModal('audioEditOverlay','closeAudioEditor');updateTrimControls()}
  function openMidiEditor(id){
    const chosen=trackById(id)?.file?id:trackById(state.selectedTrack)?.file?state.selectedTrack:midiTracks().find(track=>track.file)?.id;
    if(!chosen){const empty=midiTracks()[0]||createTrack('midi');openTrackFile(empty);return}
    pause();state.selectedTrack=chosen;state.selectedNoteId=null;
    openModal('midiEditOverlay','editorScroll');renderEditor();
    requestAnimationFrame(()=>focusEditorPitch());
  }
  function updateTrimControls(){const track=trackById(state.selectedAudioTrack);if(!track?.file)return;const maximum=Math.max(0,track.sourceDuration-.1);el.trimRange.max=String(maximum);el.trimSeconds.max=String(maximum);el.trimRange.value=String(track.trimStart);el.trimSeconds.value=track.trimStart.toFixed(2);el.leadInRange.value=String(track.leadIn||0);el.leadInSeconds.value=(track.leadIn||0).toFixed(2);el.audioPitchValue.textContent=track.pitch===0?'원음 (0)':`${track.pitch>0?'+':''}${track.pitch}반음`;el.sourceDuration.textContent=fmt(track.sourceDuration);el.trimStartLabel.textContent=fmt(track.trimStart);el.leadInLabel.textContent=fmt(track.leadIn||0);el.trimRemaining.textContent=fmt(audioLength(track));drawTrimWave()}
  function setTrim(value){const track=trackById(state.selectedAudioTrack);if(!track?.file)return;if(state.playing)pause();track.trimStart=clamp(Number(value)||0,0,Math.max(0,track.sourceDuration-.1));state.position=0;track.audio.pause();track.audio.currentTime=track.trimStart;refreshSummary()}
  function setLeadIn(value){const track=trackById(state.selectedAudioTrack);if(!track?.file)return;if(state.playing)pause();track.leadIn=clamp(Number(value)||0,0,120);state.position=0;track.audio.pause();track.audio.currentTime=track.trimStart;refreshSummary()}

  function selectedTrackNotes(){return state.notes.filter(note=>note.sourceTrack===state.selectedTrack)}
  function editorBeatStep(){return beatGridStep(state.editorViewSeconds,Math.max(1,el.editorGrid.clientWidth-63))}
  function snapTime(time){const step=editorBeatStep();return beatToSeconds(Math.round(secondsToBeat(Math.max(0,time))/step)*step)}
  function maxEditorStart(){return Math.max(0,Math.ceil((Math.max(state.midiDuration,state.editorViewSeconds)+4-state.editorViewSeconds)*4)/4)}
  function editorTimeLabel(seconds){return `${Number(seconds.toFixed(2))}s`}
  function updateSelectedInfo(){
    const note=state.notes.find(item=>item.id===state.selectedNoteId);
    el.selectedNoteInfo.textContent=note?`${noteName(note.pitch)} · ${note.start.toFixed(2)}초 · 길이 ${(note.end-note.start).toFixed(2)}초`:'음표를 선택하거나 빈 칸을 두 번 클릭하세요.';
    for(const item of el.editorGrid.querySelectorAll('.editor-note'))item.classList.toggle('selected',Number(item.dataset.noteId)===state.selectedNoteId);
  }
  function selectNote(id){state.selectedNoteId=id;updateSelectedInfo()}
  function focusEditorPitch(){
    const notes=selectedTrackNotes(),focus=notes.length?notes.reduce((sum,note)=>sum+note.pitch,0)/notes.length:60;
    const middle=(127-focus)*state.editorRowHeight-el.editorScroll.clientHeight/2;
    el.editorScroll.scrollTop=clamp(middle,0,Math.max(0,el.editorScroll.scrollHeight-el.editorScroll.clientHeight));
  }
  function renderEditor(){
    if(!state.midiFile)return;
    const view=state.editorViewSeconds,row=state.editorRowHeight;
    state.editorStart=clamp(state.editorStart,0,maxEditorStart());
    el.editorWindow.max=String(maxEditorStart());el.editorWindow.value=String(state.editorStart);
    el.editorWindowLabel.textContent=`${editorTimeLabel(state.editorStart)}–${editorTimeLabel(state.editorStart+view)}`;
    el.editorZoomLabel.textContent=`${Number(view.toFixed(1))}초`;
    el.editNoteCount.textContent=`${selectedTrackNotes().length.toLocaleString('ko-KR')}개 음표 · 전체 ${state.notes.length.toLocaleString('ko-KR')}개`;
    el.undoMidi.disabled=!state.history.length;
    el.editorTrack.replaceChildren();for(const track of midiTracks().filter(item=>item.file)){const option=document.createElement('option');option.value=track.id;option.textContent=track.label.textContent;el.editorTrack.appendChild(option)}el.editorTrack.value=state.selectedTrack;
    el.editorGrid.style.height=`${128*row+30}px`;
    el.editorGrid.replaceChildren();
    const labels=document.createElement('div'),header=document.createElement('div'),area=document.createElement('div');
    labels.className='editor-pitch-labels';header.className='editor-time-header';area.className='editor-area';
    area.style.setProperty('--row-height',`${row}px`);
    for(let pitch=127;pitch>=0;pitch--){
      const label=document.createElement('div');label.className='editor-pitch-label'+(blackKeys.has(pitch%12)?' black':'');
      label.style.top=`${(127-pitch)*row}px`;label.style.height=`${row}px`;label.style.lineHeight=`${row-1}px`;
      label.textContent=noteName(pitch);labels.appendChild(label);
    }
    drawBeatGrid(area,state.editorStart,view,el.editorGrid.clientWidth-63,header);
    for(const note of selectedTrackNotes()){
      if(note.end<=state.editorStart||note.start>=state.editorStart+view)continue;
      const start=Math.max(note.start,state.editorStart),end=Math.min(note.end,state.editorStart+view);
      const button=document.createElement('button');button.type='button';
      button.className='editor-note'+(note.id===state.selectedNoteId?' selected':'')+(note.start<state.editorStart?' clipped-start':'')+(note.end>state.editorStart+view?' clipped-end':'');
      button.style.backgroundColor=midiColor(note.sourceTrack);
      button.dataset.noteId=String(note.id);
      button.style.left=`${(start-state.editorStart)/view*100}%`;
      button.style.width=`${Math.max(.25,(end-start)/view*100)}%`;
      button.style.top=`${(127-note.pitch)*row+2}px`;
      button.style.height=`${Math.max(12,row-4)}px`;
      button.textContent=noteName(note.pitch);
      button.setAttribute('aria-label',`${noteName(note.pitch)} ${note.start.toFixed(2)}초, 길이 ${(note.end-note.start).toFixed(2)}초`);
      const handle=document.createElement('span');handle.className='note-resize-handle';handle.setAttribute('aria-hidden','true');button.appendChild(handle);
      button.addEventListener('pointerdown',event=>beginNoteDrag(event,note,button,area));
      button.addEventListener('click',event=>{event.stopPropagation();selectNote(note.id)});
      button.addEventListener('focus',()=>selectNote(note.id));
      area.appendChild(button);
    }
    area.addEventListener('dblclick',event=>{
      if(event.target!==area)return;
      const box=area.getBoundingClientRect();
      const time=state.editorStart+clamp((event.clientX-box.left)/box.width,0,1)*view;
      const start=snapTime(time);
      const pitch=clamp(127-Math.floor((event.clientY-box.top)/row),0,127);
      const hand=pitch<60?'left':'right';
      const id=state.nextId++;
      editNotes(()=>{state.notes.push({id,start,end:beatToSeconds(secondsToBeat(start)+editorBeatStep()),pitch,velocity:100,hand,sourceTrack:state.selectedTrack});state.selectedNoteId=id});
      toast(`${noteName(pitch)} 음표를 추가했습니다.`);
    });
    el.editorGrid.append(labels,header,area);updateSelectedInfo();
  }
  function beginNoteDrag(event,note,button,area){
    if(event.button!==0)return;
    event.preventDefault();event.stopPropagation();selectNote(note.id);
    const rect=button.getBoundingClientRect(),edge=Math.min(10,rect.width/3);
    const mode=event.clientX>=rect.right-edge&&!button.classList.contains('clipped-end')?'resize-end':event.clientX<=rect.left+edge&&rect.width>24&&!button.classList.contains('clipped-start')?'resize-start':'move';
    const width=area.getBoundingClientRect().width;
    state.editorGesture={type:mode,id:note.id,x:event.clientX,y:event.clientY,start:note.start,end:note.end,pitch:note.pitch,width,changed:false};
    el.editorScroll.setPointerCapture(event.pointerId);
  }
  function beginEditorPan(event){
    if(event.button!==1)return;
    event.preventDefault();event.stopPropagation();
    const width=el.editorGrid.querySelector('.editor-area')?.getBoundingClientRect().width||el.editorScroll.clientWidth;
    state.editorGesture={type:'pan',x:event.clientX,y:event.clientY,start:state.editorStart,scroll:el.editorScroll.scrollTop,width};
    el.editorScroll.classList.add('panning');el.editorScroll.setPointerCapture(event.pointerId);
  }
  function moveEditorPointer(event){
    const gesture=state.editorGesture;if(!gesture)return;
    if(gesture.type==='pan'){
      const start=clamp(gesture.start-(event.clientX-gesture.x)/gesture.width*state.editorViewSeconds,0,maxEditorStart());
      if(start!==state.editorStart){state.editorStart=start;renderEditor()}
      el.editorScroll.scrollTop=gesture.scroll-(event.clientY-gesture.y);
      return;
    }
    const note=state.notes.find(item=>item.id===gesture.id);if(!note)return;
    const delta=(event.clientX-gesture.x)/gesture.width*state.editorViewSeconds;
    let start=gesture.start,end=gesture.end,pitch=gesture.pitch;
    if(gesture.type==='move'){start=Math.max(0,event.altKey?gesture.start+delta:snapTime(gesture.start+delta));end=start+(gesture.end-gesture.start);pitch=clamp(gesture.pitch-Math.round((event.clientY-gesture.y)/state.editorRowHeight),0,127)}
    else if(gesture.type==='resize-end')end=Math.max(gesture.start+.01,event.altKey?gesture.end+delta:snapTime(gesture.end+delta));
    else start=clamp(event.altKey?gesture.start+delta:snapTime(gesture.start+delta),0,gesture.end-.01);
    if(Math.abs(note.start-start)<.0001&&Math.abs(note.end-end)<.0001&&note.pitch===pitch)return;
    if(!gesture.changed){pushHistory();gesture.changed=true}
    Object.assign(note,{start,end,pitch});recalculateMidiDuration();state.nextNote=noteIndexAt(state.position);
    renderEditor();drawMidiOverview();drawViews();
  }
  function endEditorPointer(event){
    const gesture=state.editorGesture;if(!gesture)return;
    state.editorGesture=null;el.editorScroll.classList.remove('panning');
    if(el.editorScroll.hasPointerCapture?.(event.pointerId))el.editorScroll.releasePointerCapture(event.pointerId);
    if(gesture.changed)refreshSummary();
  }
  function zoomEditorTime(factor,anchor=.5){
    const center=state.editorStart+state.editorViewSeconds*anchor;
    state.editorViewSeconds=clamp(state.editorViewSeconds*factor,1,64);
    state.editorStart=Math.max(0,center-state.editorViewSeconds*anchor);renderEditor();
  }
  function zoomEditorPitch(factor){
    const centerPitch=127-(el.editorScroll.scrollTop+el.editorScroll.clientHeight/2)/state.editorRowHeight;
    state.editorRowHeight=clamp(Math.round(state.editorRowHeight*factor),14,40);
    renderEditor();el.editorScroll.scrollTop=(127-centerPitch)*state.editorRowHeight-el.editorScroll.clientHeight/2;
  }
  function deleteSelected(){
    if(state.selectedNoteId===null)return;
    const id=state.selectedNoteId;
    editNotes(()=>{state.notes=state.notes.filter(note=>note.id!==id);state.selectedNoteId=null});
    toast('음표를 삭제했습니다.');
  }

  function clearFiles(){
    stopPlayback();
    for(const track of state.tracks){if(track.type==='audio'){track.audio.pause();track.pitchVersion=(track.pitchVersion||0)+1;track.audio.removeAttribute('src');track.audio.load();if(track.url)URL.revokeObjectURL(track.url);Object.assign(track,{file:null,url:null,sourceDuration:0,trimStart:0,pitch:0,wavePeaks:null});routeAudioPitch(track)}else Object.assign(track,{file:null,tailDuration:0,bpm:null,tempoPoints:[],ticksPerBeat:480})}
    Object.assign(state,{midiFile:null,notes:[],midiTailDuration:0,midiDuration:0,tempoPoints:[],position:0,history:[],selectedNoteId:null,selectedTrack:null,selectedAudioTrack:null,practiceTrackId:null,practiceFlagTime:null,practiceDrag:null,performanceNotes:[]});
    syncMidiMetadata();
    refreshSummary();
  }
  function openTrackFile(track){state.fileTarget=track.id;(track.type==='audio'?el.audioInput:el.midiInput).click()}
  function importDroppedFiles(files,target){
    let first=true;const used=new Set();
    for(const file of files){
      const type=/\.(mid|midi)$/i.test(file.name)?'midi':/\.(mp3|wav)$/i.test(file.name)?'audio':null;
      if(!type)continue;
      const track=first&&target?.type===type?target:state.tracks.find(item=>item.type===type&&!item.file&&!used.has(item.id))||createTrack(type);
      used.add(track.id);
      if(type==='midi')loadMidi(file,track.id);else loadAudio(file,track.id);
      first=false;
    }
  }
  function connectDropZone(zone,track){
    const activate=()=>track.file?(track.type==='audio'?openAudioEditor(track.id):openMidiEditor(track.id)):openTrackFile(track);
    zone.addEventListener('click',activate);
    zone.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();activate()}});
    zone.addEventListener('dragover',event=>{event.preventDefault();zone.classList.add('drag-over')});
    zone.addEventListener('dragleave',()=>zone.classList.remove('drag-over'));
    zone.addEventListener('drop',event=>{event.preventDefault();zone.classList.remove('drag-over');importDroppedFiles(event.dataTransfer.files,track)});
  }


  el.play.addEventListener('click',()=>state.playing?pause():play());
  el.stop.addEventListener('click',()=>stopPlayback());
  el.metronome.addEventListener('click',toggleMetronome);
  el.metronomeVolume.addEventListener('input',()=>setMetronomeVolume(el.metronomeVolume.value));
  el.seek.addEventListener('input',()=>seek(Number(el.seek.value)/1000*duration()));
  el.speed.addEventListener('change',()=>setSpeed(Number(el.speed.value)));
  el.audioInput.addEventListener('change',event=>{if(event.target.files[0])loadAudio(event.target.files[0],state.fileTarget||audioTracks().find(track=>!track.file)?.id||createTrack('audio').id)});
  el.midiInput.addEventListener('change',event=>{if(event.target.files[0])loadMidi(event.target.files[0],state.fileTarget||midiTracks().find(track=>!track.file)?.id||createTrack('midi').id)});
  const importingMidiTracks=new Set();
  window.addEventListener('keyroom:import-midi',event=>{const {file,hand}=event.detail||{};if(file){const track=midiTracks().find(item=>!item.file&&!importingMidiTracks.has(item.id))||createTrack('midi');importingMidiTracks.add(track.id);loadMidi(file,track.id,hand).finally(()=>importingMidiTracks.delete(track.id))}});
  document.addEventListener('dragover',event=>event.preventDefault());
  document.addEventListener('drop',event=>{event.preventDefault();if(event.target.closest('.drop-target'))return;importDroppedFiles(event.dataTransfer.files)});

  $('clearFiles').addEventListener('click',clearFiles);
  el.connectMidi.addEventListener('click',connectMidi);
  el.toggleComputerKeyboard.addEventListener('click',toggleComputerKeyboard);
  $('keyboardDemo').addEventListener('click',()=>{
    const panel=$('computerKeyboard'),show=panel.hidden;
    panel.hidden=!show;
    $('keyboardDemo').setAttribute('aria-expanded',String(show));
    if(!show&&state.computerKeyboardOn)toggleComputerKeyboard();
  });
  document.addEventListener('keydown',handleComputerKeyDown);
  document.addEventListener('keyup',handleComputerKeyUp);
  window.addEventListener('blur',()=>releaseHeldNotes('keyboard:'));
  document.addEventListener('visibilitychange',()=>{if(document.hidden)releaseHeldNotes('keyboard:')});
  el.midiDevice.addEventListener('change',()=>selectMidiInput(el.midiDevice.value));
  el.recordPerformance.addEventListener('click',toggleRecording);
  el.clearPerformance.addEventListener('click',()=>{state.performanceNotes=[];renderPerformanceStatus();renderPracticeOverview();drawViews()});
  el.downloadPerformance.addEventListener('click',downloadPerformance);
  $('jumpToMidiInput').addEventListener('click',()=>{$('midiInputTitle').scrollIntoView({behavior:'smooth',block:'center'});$('keyboardDemo').focus()});
  $('addAudioTrack').addEventListener('click',()=>openTrackFile(createTrack('audio')));
  $('addMidiTrack').addEventListener('click',()=>openTrackFile(createTrack('midi')));
  el.originalBpm.addEventListener('change',()=>{
    if(!el.originalBpm.value.trim()){
      state.originalBpmManual=false;syncMidiMetadata();refreshSummary();return;
    }
    state.originalBpm=clamp(Math.round(Number(el.originalBpm.value)||state.originalBpm||120),30,300);
    state.originalBpmManual=true;
    if(!state.gridBpmManual)state.gridBpm=state.originalBpm;
    applyPlaybackSpeed();refreshSummary();
    if(!$('midiEditOverlay').classList.contains('hidden'))renderEditor();
  });
  el.bpm.addEventListener('change',()=>{
    if(!state.originalBpm&&duration()){el.bpm.value=String(state.gridBpm);toast('원본 BPM을 입력하거나 MIDI를 불러오세요.');return}
    if(!el.bpm.value.trim()){state.gridBpmManual=false;state.gridBpm=state.originalBpm||120;applyPlaybackSpeed();refreshSummary();return}
    state.gridBpm=clamp(Math.round(Number(el.bpm.value)||state.gridBpm),30,300);
    state.gridBpmManual=true;
    applyPlaybackSpeed();refreshSummary();
  });
  $('openResources').addEventListener('click',()=>openModal('resourceOverlay','closeResources'));
  $('closeResources').addEventListener('click',()=>closeModal('resourceOverlay'));
  for(const [button,type] of [['drawerAudio','audio'],['drawerMidi','midi']])$(button).addEventListener('click',()=>{closeModal('resourceOverlay');openTrackFile(createTrack(type))});
  $('openPlayView').addEventListener('click',()=>openModal('viewOverlay','practiceScrub'));
  $('closePlayView').addEventListener('click',()=>closeModal('viewOverlay'));
  const fallStage=$('view-fall');
  fallStage.addEventListener('wheel',event=>{
    if(event.ctrlKey||event.shiftKey||Math.abs(event.deltaX)>Math.abs(event.deltaY)||!event.deltaY)return;
    const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?fallStage.clientHeight:1);
    if(event.altKey){
      event.preventDefault();
      state.fallKeyWidth=clamp(state.fallKeyWidth*Math.exp(clamp(delta,-120,120)*.003),20,100);
      drawFall();
    }else if(event.metaKey){
      event.preventDefault();
      state.fallScale=clamp(state.fallScale*Math.exp(-clamp(delta,-120,120)*.003),36,360);
      el.fallSpeedLabel.textContent=`${(state.fallScale/56).toFixed(1)}×`;
      drawFall();
    }else if(duration()){
      event.preventDefault();
      seek(currentPosition()+clamp(delta,-240,240)/120);
    }
  },{passive:false});
  el.placePracticeFlag.addEventListener('click',()=>setPracticeFlag(currentPosition()));
  el.clearPracticeFlag.addEventListener('click',()=>{state.practiceFlagTime=null;updatePracticeTransport()});
  el.practiceScrub.addEventListener('pointerdown',event=>startPracticeDrag(event,'seek'));
  el.practiceFlag.addEventListener('pointerdown',event=>startPracticeDrag(event,'flag'));
  el.practiceScrub.addEventListener('pointermove',movePracticeDrag);
  el.practiceScrub.addEventListener('pointerup',endPracticeDrag);
  el.practiceScrub.addEventListener('pointercancel',endPracticeDrag);
  el.placeTimelineFlag.addEventListener('click',()=>setPracticeFlag(currentPosition()));
  el.clearTimelineFlag.addEventListener('click',()=>{state.practiceFlagTime=null;updatePracticeTransport()});
  el.timelineFlag.addEventListener('pointerdown',startTimelineFlagDrag);
  el.timelineFlag.addEventListener('pointermove',moveTimelineFlagDrag);
  el.timelineFlag.addEventListener('pointerup',endTimelineFlagDrag);
  el.timelineFlag.addEventListener('pointercancel',endTimelineFlagDrag);
  el.practiceScrub.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();
    if(event.key==='Home')seek(0);
    else if(event.key==='End')seek(Math.max(0,duration()-.01));
    else{const beat=secondsToBeat(state.position),next=beat+(event.key==='ArrowRight'?1:-1);seek(beatToSeconds(Math.max(0,next)))}
  });
  $('openAudioEditor').addEventListener('click',()=>openAudioEditor());
  $('closeAudioEditor').addEventListener('click',()=>closeModal('audioEditOverlay'));
  $('openMidiEditor').addEventListener('click',()=>openMidiEditor());
  $('closeMidiEditor').addEventListener('click',()=>closeModal('midiEditOverlay'));
  $('doneMidi').addEventListener('click',()=>closeModal('midiEditOverlay'));

  for(const overlay of document.querySelectorAll('.overlay,.modal-overlay'))overlay.addEventListener('click',event=>{if(event.target===overlay)closeModal(overlay.id)});
  document.querySelectorAll('.tab').forEach(tab=>tab.addEventListener('click',()=>{state.tab=tab.dataset.view;document.querySelectorAll('.tab').forEach(item=>{item.classList.toggle('active',item===tab);item.setAttribute('aria-selected',String(item===tab))});document.querySelectorAll('.view-stage').forEach(stage=>stage.classList.toggle('hidden',stage.id!==`view-${state.tab}`));$('fallLegend').classList.toggle('hidden',state.tab!=='fall');$('rollLegend').classList.toggle('hidden',state.tab!=='roll');requestAnimationFrame(drawViews)}));document.querySelectorAll('[data-feature]').forEach(button=>button.addEventListener('click',()=>toast(`${button.dataset.feature} 기능은 다음 단계에서 연결할 예정입니다.`)));
  el.trimRange.addEventListener('input',()=>setTrim(el.trimRange.value));el.trimSeconds.addEventListener('change',()=>setTrim(el.trimSeconds.value));el.leadInRange.addEventListener('input',()=>setLeadIn(el.leadInRange.value));el.leadInSeconds.addEventListener('change',()=>setLeadIn(el.leadInSeconds.value));$('resetTrim').addEventListener('click',()=>{setTrim(0);setLeadIn(0)});$('previewTrim').addEventListener('click',()=>{if(state.playing)pause();else{seek(0);play(false)}});$('applyTrim').addEventListener('click',()=>closeModal('audioEditOverlay'));$('replaceAudio').addEventListener('click',()=>{closeModal('audioEditOverlay');openTrackFile(trackById(state.selectedAudioTrack))});
  $('audioPitchDown').addEventListener('click',()=>transposeAudio(-1));
  $('audioPitchUp').addEventListener('click',()=>transposeAudio(1));
  $('transposeDown').addEventListener('click',()=>transpose(-1));
  $('transposeUp').addEventListener('click',()=>transpose(1));
  el.undoMidi.addEventListener('click',undoMidi);
  $('replaceMidi').addEventListener('click',()=>{closeModal('midiEditOverlay');openTrackFile(trackById(state.selectedTrack))});
  $('downloadMidi').addEventListener('click',exportMidi);
  el.editorWindow.addEventListener('input',()=>{state.editorStart=Number(el.editorWindow.value);renderEditor()});
  el.editorTrack.addEventListener('change',()=>{state.selectedTrack=el.editorTrack.value;state.selectedNoteId=null;renderEditor();focusEditorPitch()});
  $('editorZoomIn').addEventListener('click',()=>zoomEditorTime(.75));
  $('editorZoomOut').addEventListener('click',()=>zoomEditorTime(4/3));
  el.editorScroll.addEventListener('pointerdown',beginEditorPan);
  el.editorScroll.addEventListener('pointermove',moveEditorPointer);
  el.editorScroll.addEventListener('pointerup',endEditorPointer);
  el.editorScroll.addEventListener('pointercancel',endEditorPointer);
  el.editorScroll.addEventListener('auxclick',event=>{if(event.button===1)event.preventDefault()});
  el.editorScroll.addEventListener('wheel',event=>{if(!event.metaKey&&!event.ctrlKey)return;event.preventDefault();const box=el.editorGrid.querySelector('.editor-area')?.getBoundingClientRect();const anchor=box?clamp((event.clientX-box.left)/box.width,0,1):.5;zoomEditorTime(Math.exp((event.metaKey?-1:1)*event.deltaY*.002),anchor)},{passive:false});
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'){
      const open=[...document.querySelectorAll('.overlay,.modal-overlay')].find(item=>!item.classList.contains('hidden'));
      if(open){closeModal(open.id);return}
    }
    const editorOpen=!$('midiEditOverlay').classList.contains('hidden');
    const typing=['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)||document.activeElement?.isContentEditable;
    if(event.code==='Space'&&!$('viewOverlay').classList.contains('hidden')&&!typing&&!event.metaKey&&!event.ctrlKey&&!event.altKey){
      event.preventDefault();if(event.repeat)return;
      if(state.playing)pause();else play(!event.shiftKey);
      return;
    }
    if(editorOpen&&!typing){
      if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='z'){event.preventDefault();undoMidi();return}
      if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();deleteSelected();return}
      const plus=event.key==='+'||event.key==='='||event.code==='NumpadAdd';
      const minus=event.key==='-'||event.key==='_'||event.code==='NumpadSubtract';
      if(plus||minus){event.preventDefault();if(event.altKey)zoomEditorPitch(plus?1.2:1/1.2);else zoomEditorTime(plus?.75:4/3);return}
    }
    if(event.code==='Space'&&!['INPUT','BUTTON','SELECT','TEXTAREA'].includes(document.activeElement?.tagName)&&$('resourceOverlay').classList.contains('hidden')&&$('audioEditOverlay').classList.contains('hidden')&&!editorOpen){event.preventDefault();state.playing?pause():play(!event.shiftKey)}
  });

  window.addEventListener('resize',()=>{refreshSummary();if(!$('midiEditOverlay').classList.contains('hidden'))renderEditor()});
  if(document.modelContext?.registerTool){try{Promise.resolve(document.modelContext.registerTool({name:'control_practice_playback',title:'연습 재생 제어',description:'현재 불러온 오디오와 MIDI의 재생, 일시정지, 정지 또는 위치 이동을 실행합니다.',inputSchema:{type:'object',properties:{action:{type:'string',enum:['play','pause','stop','seek']},seconds:{type:'number',minimum:0}},required:['action'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},async execute(input){if(!input||!['play','pause','stop','seek'].includes(input.action))throw Error('올바른 재생 동작을 선택하세요.');if(input.action==='seek'){if(!Number.isFinite(input.seconds)||input.seconds<0||input.seconds>duration())throw Error('재생 위치가 범위를 벗어났습니다.');seek(input.seconds)}else if(input.action==='play')await play();else if(input.action==='pause')pause();else stopPlayback();return {playing:state.playing,position:state.position,duration:duration(),audioLoaded:audioTracks().some(track=>!!track.file),midiLoaded:!!state.midiFile}}})).catch(()=>{})}catch(e){}}
  buildComputerKeyboard();createTrack('audio');createTrack('midi');refreshSummary();
})();
