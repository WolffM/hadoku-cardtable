"""Trailer cut 3 caption options, round 1 (A title card, B centred, C top kicker, D right rail) on the
counter-war beat. `python3 -I e2e/promo/captions/round1.py`; output in e2e/.run/promo/captions/."""
import subprocess
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / ".run" / "promo" / "captions"
OUT.mkdir(parents=True, exist_ok=True)
SRC = "/home/hadoku/repos/hadoku-cardtable/.claude/worktrees/promo/e2e/.run/promo/counterwar/counterwar.mkv"
BOLD = "/usr/share/fonts/truetype/noto/NotoSans-Black.ttf"
REG = "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf"
ACC = "0xB497FF"
START, SPEED, LEN = 6.0, 2.4, 5.0
base = f"trim=start={START}:end={START+LEN*SPEED},setpts=(PTS-STARTPTS)/{SPEED},fps=60"
def fade(a, b):  # text alpha: in over 0.25 s from a, out over 0.25 s to b
    return f"if(lt(t,{a}),0,if(lt(t,{a}+0.25),(t-{a})/0.25,if(lt(t,{b}-0.25),1,if(lt(t,{b}),({b}-t)/0.25,0))))"
T = "Watch the stack unfold"
styles = {
  # A: a full-frame card, hard cut in and out, then the footage clean
  "a-card": f"{base},drawbox=x=0:y=0:w=iw:h=ih:color=0x141218:t=fill:enable='lt(t,1.3)',"
            f"drawtext=fontfile={BOLD}:text='{T}':fontsize=96:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:enable='lt(t,1.3)'",
  # B: centred over the frame, dimmed and softened behind the words for 1.8 s
  "b-centre": f"split[o][b];[b]boxblur=12:2,eq=brightness=-0.18[bl];[o][bl]overlay=enable='lt(t,1.8)',"
              f"drawtext=fontfile={BOLD}:text='{T}':fontsize=104:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:alpha='{fade(0,1.8)}':shadowcolor=black@0.7:shadowy=4",
  # C: a top-left kicker over the opponent's hand band, no bar and no shading
  "c-kicker": f"{base},drawtext=fontfile={REG}:text='THE STACK':fontsize=26:fontcolor={ACC}:x=702:y=118:alpha='{fade(0.2,3.6)}',"
              f"drawtext=fontfile={BOLD}:text='{T}':fontsize=58:fontcolor=white:x=700:y=150:alpha='{fade(0.2,3.6)}':shadowcolor=black@0.8:shadowy=3",
  # D: in the empty chat rail at the right, which no clip uses
  "d-rail": f"{base},drawbox=x=1601:y=82:w=319:h=948:color=0x141218@0.92:t=fill:enable='between(t,0.2,3.8)',"
            f"drawtext=fontfile={REG}:text='THE STACK':fontsize=22:fontcolor={ACC}:x=1636:y=420:alpha='{fade(0.2,3.8)}',"
            f"drawtext=fontfile={BOLD}:text='Watch the':fontsize=50:fontcolor=white:x=1634:y=452:alpha='{fade(0.2,3.8)}',"
            f"drawtext=fontfile={BOLD}:text='stack':fontsize=50:fontcolor=white:x=1634:y=512:alpha='{fade(0.2,3.8)}',"
            f"drawtext=fontfile={BOLD}:text='unfold':fontsize=50:fontcolor=white:x=1634:y=572:alpha='{fade(0.2,3.8)}'",
}
for name, vf in styles.items():
    if name == "b-centre":
        vf = f"{base},{vf}"
    vf += ",scale=1280:720:flags=lanczos"
    subprocess.run(["ffmpeg","-loglevel","error","-y","-i",SRC,"-vf",vf,"-an","-c:v","libx264","-preset","slow","-crf","24","-pix_fmt","yuv420p","-movflags","+faststart",str(OUT / f"{name}.mp4")],check=True)
    subprocess.run(["ffmpeg","-loglevel","error","-y","-ss","1.0" if name!="a-card" else "0.6","-i",str(OUT / f"{name}.mp4"),"-frames:v","1","-q:v","3",str(OUT / f"{name}.jpg")],check=True)
    print(name)
