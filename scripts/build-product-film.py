#!/usr/bin/env python3
"""Stage real captures and author the reproducible 60-second HyperFrames film.

Run at any cwd. macOS `say` makes the local preview narration; FFmpeg normalizes
it. Existing WAV files are reused when the script text is unchanged. No network
request, source-image alteration or application mock is made by this script.
"""
from pathlib import Path
import html, json, shutil, subprocess, sys, tempfile

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT / 'docs/video-source'
ASSETS = PROJECT / 'assets'
DELIVERY = ROOT / 'docs/assets/video'
SHOTS = [
    dict(id='welcome', start=0, end=6, title='让你的 Agent，\n接上整个团队。', sub='Your agents. Your team. One place.', assets=['chat-knowledge-answer'], voice='让你的智能助手，接上整个团队。这就是 Greenhouse。', en='Let your agent work with your whole team. This is Greenhouse.'),
    dict(id='connect', start=6, end=12, title='带上你熟悉的 Agent', sub='Codex · Claude Code · Cursor · MCP', assets=['agent-connect-wizard'], voice='连接你熟悉的 Agent，按成员权限，访问团队资源。', en='Connect your own agent to team resources, within your permissions.'),
    dict(id='knowledge', start=12, end=18, title='答案，有团队的依据', sub='Knowledge · Files · Cited answers', assets=['knowledge-doc','chat-knowledge-answer'], voice='查知识，读文件，回答有依据，成果有归处。', en='Search knowledge, read files and follow answers back to their sources.'),
    dict(id='work', start=18, end=26, title='从数据，走到下一步', sub='Tables · Analysis · Projects', assets=['chat-tables-answer','project-board'], voice='分析表格，跟进项目。数据、任务和讨论，都围绕工作展开。', en='Analyze tables and move projects forward, with tasks and discussion together.'),
    dict(id='results', start=26, end=37, title='把好方法，变成日常', sub='Skills · Reports · Automations', assets=['report-templates','automations'], voice='共享技能，按团队模板生成报告，保存到文件。让重复工作定时完成，随时查看结果。', en='Share skills, create reports from team templates and save them to Files. Schedule recurring work and revisit its results.'),
    dict(id='devices', start=37, end=48, title='在桌前，也在路上', sub='Web · iPhone · iPad', assets=['ios-ipad','ios-chat'], voice='网页、苹果手机和平板，随时对话、查阅资料、跟进进展。也可以配置飞书机器人。', en='Continue on the web, iPhone and iPad. Chat, find information and follow progress. A Feishu bot is optional.'),
    dict(id='control', start=48, end=56, title='放手做事，边界清晰', sub='Permissions · Activity · Budgets', assets=['activity-log','services-pricing'], voice='权限有边界，写入有记录，删除先预览。每一笔付费调用，都有预算。', en='Scoped access, recorded MCP writes and deletion previews. Paid calls count toward clear budgets.'),
    dict(id='closing', start=56, end=60, title='给团队一片生长的空间', sub='Open source. Self-hosted.', assets=[], voice='开源，自主部署。让团队一起生长。', en='Open source. Self-hosted. A place for your team to grow.'),
]

def run(args):
    subprocess.run([str(a) for a in args], check=True)

def timestamp(seconds):
    ms = round(seconds * 1000)
    return f'{ms//3600000:02d}:{ms//60000%60:02d}:{ms//1000%60:02d}.{ms%1000:03d}'

def main():
    for path in [ASSETS/'screens', ASSETS/'brand', ASSETS/'audio', PROJECT/'compositions', DELIVERY]: path.mkdir(parents=True, exist_ok=True)
    for name in sorted({asset for s in SHOTS for asset in s['assets']}):
        src = ROOT / f'docs/assets/screens/{name}.webp'
        if not src.exists(): raise SystemExit(f'Missing real capture: {src}')
        shutil.copy2(src, ASSETS/'screens'/src.name)
    for name in ['mark.svg','logo.svg']: shutil.copy2(ROOT/'docs/assets/brand'/name, ASSETS/'brand'/name)
    ledger=[]
    for s in SHOTS:
        txt=ASSETS/'audio'/f'{s["id"]}.txt'; wav=txt.with_suffix('.wav'); aiff=txt.with_suffix('.aiff')
        if not wav.exists() or not txt.exists() or txt.read_text()!=s['voice']:
            txt.write_text(s['voice'])
            run(['say','-v','Tingting','-r','205','-f',txt,'-o',aiff])
            duration=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',str(aiff)],text=True))
            available=s['end']-s['start']-.55
            tempo=max(1,duration/available)
            run(['ffmpeg','-y','-loglevel','error','-i',aiff,'-af',f'atempo={tempo:.5f},loudnorm=I=-17:TP=-1.5:LRA=7','-ar','48000',wav])
            aiff.unlink()
        s['audioDuration']=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',str(wav)],text=True))
        ledger.append({'id':s['id'],'audio':'macOS Tingting, local synthesis','screens':s['assets'],'narrationSeconds':s['audioDuration']})
    (PROJECT/'narration.json').write_text(json.dumps(SHOTS,ensure_ascii=False,indent=2)+'\n')
    (PROJECT/'assets/ledger.json').write_text(json.dumps(ledger,ensure_ascii=False,indent=2)+'\n')
    for lang in ['zh','en']:
        cues=['WEBVTT','']
        for s in SHOTS:
            cues += [f'{timestamp(s["start"]+.2)} --> {timestamp(s["end"]-.1)}',s['voice'] if lang=='zh' else s['en'],'']
        (DELIVERY/f'overview.{lang}.vtt').write_text('\n'.join(cues))
    fonts="""@font-face{font-family:Nunito;src:url('assets/fonts/nunito-variable.woff2')}@font-face{font-family:NotoSC;src:url('assets/fonts/NotoSansSC-Regular.subset.ttf');font-weight:400}@font-face{font-family:NotoSC;src:url('assets/fonts/NotoSansSC-Bold.subset.ttf');font-weight:800}"""
    hosts=[];audios=[]
    for i,s in enumerate(SHOTS):
        ident=s['id'];dur=s['end']-s['start'];mid=round(dur/2,2)
        hosts.append(f'<div id="{ident}" class="clip" data-composition-id="{ident}" data-composition-src="compositions/{ident}.html" data-start="{s["start"]}" data-duration="{dur}" data-track-index="1" data-track-kind="graphics" data-width="1920" data-height="1080"></div>')
        audios.append(f'<audio id="voice-{ident}" class="clip" src="assets/audio/{ident}.wav" data-start="{s["start"]+.2}" data-duration="{s["audioDuration"]:.3f}" data-track-index="2" data-volume="1"></audio>')
        css=fonts+"""*{box-sizing:border-box}#root{position:absolute;inset:0;background:#FAFBF8;color:#203B31;font-family:Nunito,NotoSC,sans-serif;overflow:hidden}.ground{position:absolute;inset:0;background:#FAFBF8}.copy{position:absolute;left:110px;top:94px;z-index:3}h1{white-space:pre-line;font:800 70px/1.3 NotoSC,sans-serif;letter-spacing:-2px;margin:0;color:#235D4D}p{font:400 30px/1.6 Nunito,NotoSC,sans-serif;color:#58675E;margin:15px 0 0}.stage{position:absolute;left:110px;right:110px;top:290px;bottom:110px;background:#E9EFDF;overflow:hidden;border-radius:20px}.screen{position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden}.screen img{width:100%;height:100%;object-fit:cover;object-position:50% 18%}.scene-caption{position:absolute;bottom:36px;left:190px;right:190px;text-align:center;font:400 26px/1.5 NotoSC,sans-serif;color:#58675E}.phone{position:absolute;width:284px;height:618px;right:150px;top:35px;border:8px solid #203B31;border-radius:44px;overflow:hidden;background:#fff}.phone img{width:100%;height:100%;object-fit:cover}.ipad{position:absolute;left:160px;top:32px;width:880px;border:9px solid #203B31;border-radius:25px;overflow:hidden}.ipad img{display:block;width:100%}.hf-fade-through-wash{position:absolute;inset:0;opacity:0;pointer-events:none;background:#FAFBF8;z-index:9}.brandmark{width:190px;height:190px;object-fit:contain}.closing{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:36px}.closing img{width:590px}.closing h1{font-size:56px}.closing p{margin:0;font-size:34px}.closing .url{font:800 36px Nunito,sans-serif;margin-top:25px;color:#235D4D}.welcome-title{position:absolute;left:110px;top:170px;width:690px;z-index:3}.welcome-title h1{font-size:82px;line-height:1.35}.welcome-title p{font-size:34px;max-width:600px}.welcome-stage{position:absolute;left:850px;right:-330px;top:140px;height:720px;overflow:hidden;border-radius:20px;border:1px solid #B1D2BF}.welcome-stage img{height:100%;width:auto;display:block}.welcome-mark{position:absolute;left:110px;bottom:170px;width:110px;height:110px}"""
        title=html.escape(s['title']).replace('\n','<br>'); subtitle=html.escape(s['sub'])
        if ident=='closing':
            body=f'<div class="ground"></div><div id="{ident}-visual" class="closing"><img src="assets/brand/logo.svg" alt="Greenhouse"><h1 data-var-text="title">{title}</h1><p>{subtitle}</p><p class="url">greenhouse.linjiejim.com</p></div>'
            motion=f'tl.fromTo("#{ident}-visual",{{scale:.94,opacity:0}},{{scale:1,opacity:1,duration:.65,ease:"power4.out"}},0);'
        elif ident=='welcome':
            body=f'<div class="ground"></div><div class="welcome-title"><h1 id="{ident}-title" data-var-text="title">{title}</h1><p>{subtitle}</p></div><div class="welcome-stage" data-layout-allow-overflow><img id="{ident}-screen" src="assets/screens/{s["assets"][0]}.webp" alt="Real Sprouty answer"></div><img class="welcome-mark" src="assets/brand/mark.svg" alt="Haven mark">'
            motion=f'tl.fromTo("#{ident}-title",{{y:18}},{{y:0,duration:.65,ease:"power4.out"}},0);tl.fromTo("#{ident}-screen",{{x:0}},{{x:-180,duration:4.5,ease:"power2.inOut"}},.5);'
        else:
            body=f'<div class="ground"></div><div class="copy"><h1 id="{ident}-title" data-var-text="title">{title}</h1><p>{subtitle}</p></div><div class="stage" data-hold id="{ident}-stage">'
            motion=f'tl.fromTo("#{ident}-title",{{y:22,opacity:0}},{{y:0,opacity:1,duration:.5,ease:"power4.out"}},0);'
            if ident=='devices':
                body+=f'<div class="ipad" id="{ident}-ipad"><img src="assets/screens/ios-ipad.webp" alt="Native iPad"></div><div class="phone" id="{ident}-phone"><img src="assets/screens/ios-chat.webp" alt="Native iPhone"></div>'
                motion+=f'tl.fromTo("#{ident}-ipad",{{x:-80,opacity:0}},{{x:0,opacity:1,duration:.7,ease:"power4.out"}},.15);tl.fromTo("#{ident}-phone",{{x:90,opacity:0}},{{x:0,opacity:1,duration:.75,ease:"power4.out"}},.35);tl.to("#{ident}-phone",{{y:-22,duration:1,ease:"power2.inOut"}},5);'
            else:
                for n,asset in enumerate(s['assets']):body+=f'<div id="{ident}-screen-{n}" class="screen"><img src="assets/screens/{asset}.webp" alt="Real {asset} screen"></div>'
                if len(s['assets'])==2:
                    body+='<div class="hf-fade-through-wash"></div>'
                    motion+=f'tl.set("#{ident}-screen-1",{{opacity:0}},0);tl.to("#{ident}-screen-0",{{opacity:0,duration:.45,ease:"power2.inOut"}},{mid-.35});tl.to("#{ident}-screen-1",{{opacity:1,duration:.55,ease:"power2.out"}},{mid-.35});'
                motion+=f'tl.fromTo("#{ident}-stage",{{y:45,opacity:0}},{{y:0,opacity:1,duration:.65,ease:"power4.out"}},.1);'
            body+='</div>'
        scene=f'''<template><style>{css}</style><div id="root" data-composition-id="{ident}" data-width="1920" data-height="1080" data-composition-variables='[{{"id":"title","type":"string","label":"Title","default":{json.dumps(s['title'],ensure_ascii=False)}}}]'>{body}</div><script>const tl=gsap.timeline({{paused:true}});{motion}window.__timelines=window.__timelines||{{}};window.__timelines['{ident}']=tl;</script></template>'''
        (PROJECT/'compositions'/f'{ident}.html').write_text(scene)
    root=f'''<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Greenhouse — one minute</title><script src="assets/gsap.min.js"></script><style>html,body{{margin:0;width:1920px;height:1080px;background:#FAFBF8;overflow:hidden}}#root{{position:absolute;inset:0}}.clip[data-composition-src]{{position:absolute;inset:0}}</style></head><body><div id="root" data-composition-id="main" data-start="0" data-duration="60" data-width="1920" data-height="1080">{''.join(hosts)}{''.join(audios)}</div><script>window.__timelines=window.__timelines||{{}};window.__timelines.main=gsap.timeline({{paused:true}});</script></body></html>'''
    (PROJECT/'index.html').write_text(root)
    print('Film source authored: 60s, 8 scenes, local voice, real screenshots.')

def finalize():
    """Add selectable subtitle tracks without recompressing the rendered picture or voice."""
    video = DELIVERY / 'greenhouse-overview.mp4'
    with tempfile.TemporaryDirectory(prefix='greenhouse-film-') as directory:
        output = Path(directory) / video.name
        run(['ffmpeg', '-y', '-loglevel', 'error', '-i', video,
             '-i', DELIVERY/'overview.zh.vtt', '-i', DELIVERY/'overview.en.vtt',
             '-map', '0:v:0', '-map', '0:a:0', '-map', '1', '-map', '2',
             '-c:v', 'copy', '-c:a', 'copy', '-c:s', 'mov_text',
             '-metadata:s:s:0', 'language=zho', '-metadata:s:s:0', 'title=中文',
             '-metadata:s:s:1', 'language=eng', '-metadata:s:s:1', 'title=English',
             '-disposition:s:0', 'default', '-movflags', '+faststart', output])
        shutil.copyfile(output, video)
    print('Embedded Chinese and English subtitles into the delivered MP4.')

if __name__=='__main__':
    if sys.argv[1:] == ['--finalize']:
        finalize()
    elif not sys.argv[1:]:
        main()
    else:
        raise SystemExit('Usage: build-product-film.py [--finalize]')
