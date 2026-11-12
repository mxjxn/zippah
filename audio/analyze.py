#!/usr/bin/env python3
"""Analysis pass for the zippah listen test recordings (48 kHz stereo s16)."""
import wave, sys
import numpy as np

DIR = "/home/mxjxn/workspace/zippah/audio/"
SR = 48000

def load(name):
    with wave.open(DIR + name, "rb") as w:
        assert w.getframerate() == SR and w.getnchannels() == 2, (w.getframerate(), w.getnchannels())
        d = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768.0
    return d[0::2], d[1::2]  # L, R

def rms(x):
    return float(np.sqrt(np.mean(x**2))) if len(x) else 0.0

def envelope(x, win_ms=5):
    n = int(SR * win_ms / 1000)
    m = len(x) // n
    e = np.sqrt((x[: m * n].reshape(m, n) ** 2).mean(axis=1))
    return e, n / SR  # env, seconds per bin

def onsets(x, thresh_ratio=0.35, min_gap_ms=80, band=None):
    """Onset times via envelope rise detection, optionally band-limited."""
    if band:
        X = np.fft.rfft(x)
        f = np.fft.rfftfreq(len(x), 1 / SR)
        mask = (f >= band[0]) & (f <= band[1])
        X[~mask] = 0
        x = np.fft.irfft(X, len(x))
    e, spb = envelope(x)
    hi = e.max()
    if hi <= 0:
        return []
    th = hi * thresh_ratio
    out, last = [], -1e9
    for i in range(1, len(e)):
        if e[i] > th and e[i] > 1.8 * e[i - 1] and i * spb - last > min_gap_ms / 1000:
            out.append(round(i * spb, 3))
            last = i * spb
    return out

def band_rms_db(L, R, fc, bw=20):
    """RMS (dBFS) of the component in [fc-bw, fc+bw] per channel."""
    out = []
    for x in (L, R):
        X = np.fft.rfft(x)
        f = np.fft.rfftfreq(len(x), 1 / SR)
        X[(f < fc - bw) | (f > fc + bw)] = 0
        y = np.fft.irfft(X, len(x))
        out.append(20 * np.log10(max(rms(y), 1e-9)))
    return out

def iois(times):
    return [round(b - a, 3) for a, b in zip(times, times[1:])]

print("=" * 72)
# STEP 1: seed buffer
L, R = load("step1-seed.wav")
print(f"STEP 1 seed: dur={len(L)/SR:.1f}s  RMS L={rms(L):.4f} R={rms(R):.4f}")
kick = onsets(L, band=(30, 150), thresh_ratio=0.3, min_gap_ms=200)
print(f"  kick onsets ({len(kick)}): {kick[:16]}")
k_ioi = iois(kick)
print(f"  kick IOIs (ms): {[round(t*1000) for t in k_ioi][:12]}  (118bpm beat = 508ms)")
bass = onsets(L, band=(80, 400), thresh_ratio=0.25, min_gap_ms=120)
b_low = [t for t in bass if not any(abs(t - k) < 0.03 for k in kick)]
print(f"  bass-ish onsets not coincident with kick ({len(b_low)}): {b_low[:14]}")
print(f"  bass IOIs (ms): {[round(t*1000) for t in iois(b_low)][:12]}")
# saw sweep: spectral centroid over first 3.5s
seg = L[: int(3.4 * SR)]
cent = []
for i in range(6):
    s = seg[i * len(seg) // 6 : (i + 1) * len(seg) // 6]
    X = np.abs(np.fft.rfft(s)) ** 2
    f = np.fft.rfftfreq(len(s), 1 / SR)
    cent.append(round(float((f * X).sum() / X.sum())))
print(f"  saw-sweep spectral centroid over 3.4s (Hz): {cent}")

print("=" * 72)
# STEP 2: (demo (sin-osc 440)) — mono centered?
L, R = load("step2-sin440.wav")
print(f"STEP 2 sin-osc 440: dur={len(L)/SR:.1f}s")
lo, ro = band_rms_db(L, R, 440, 15)
print(f"  440Hz band RMS: L={lo:.1f} dBFS  R={ro:.1f} dBFS  diff={abs(lo-ro):.2f} dB")
# spectral purity: top 3 peaks in stable window
w = L[int(0.5 * SR) : int(2.5 * SR)]
X = np.abs(np.fft.rfft(w))
f = np.fft.rfftfreq(len(w), 1 / SR)
pk = np.argsort(X)[-600:]
peaks = sorted({round(f[p]) for p in pk if X[p] > 0.05 * X.max()})
print(f"  dominant bins near peak: {peaks[:8]} Hz")
d = np.abs(np.diff(L[int(0.5 * SR) : int(2.5 * SR)]))
print(f"  max sample jump in window: {d.max():.4f} (click check)")

print("=" * 72)
# STEP 4: ctl/kill — saw 220 -> ctl 330 -> kill
L, R = load("step4-ctl-kill.wav")
print(f"STEP 4 ctl/kill: dur={len(L)/SR:.1f}s  (eval timeline: start@~0.3s, ctl@~2.3s, kill@~4.8s)")
for a, b, tag in [(0.3, 2.2, "before ctl"), (2.5, 4.5, "after ctl"), (5.2, 6.5, "after kill")]:
    s = slice(int(a * SR), int(b * SR))
    p220 = band_rms_db(L[s], R[s], 220, 8)
    p330 = band_rms_db(L[s], R[s], 330, 8)
    print(f"  {tag:10s} [{a:.1f}-{b:.1f}s] RMS L={rms(L[s]):.4f}  220Hz L={p220[0]:.1f}dB  330Hz L={p330[0]:.1f}dB")

print("=" * 72)
# STEP 5b: pdef quant 4 -> swap -> pstop
L, R = load("step5b-pdef.wav")
print(f"STEP 5b pdef: dur={len(L)/SR:.1f}s  (eval timeline: pdef@~0.3s, swap@~7.3s, pstop@~12.3s)")
ons = onsets(L, band=(80, 800), thresh_ratio=0.22, min_gap_ms=60)
print(f"  note onsets ({len(ons)}): {ons}")
beat = 60 / 118
print(f"  118bpm: beat={beat*1000:.0f}ms, half={beat*500:.0f}ms, quarter={beat*250:.0f}ms, bar(4)={beat*4000:.0f}ms")
print(f"  IOIs (ms): {[round(t*1000) for t in iois(ons)]}")

print("=" * 72)
# STEP 6: tempo 118 -> 132
L, R = load("step6-tempo.wav")
print(f"STEP 6 tempo: dur={len(L)/SR:.1f}s  (eval timeline: loop@~0.3s, bpm132@~4.3s, stop-loop@~8.3s)")
kick = onsets(L, band=(30, 150), thresh_ratio=0.3, min_gap_ms=200)
print(f"  kick onsets: {kick}")
print(f"  IOIs (ms): {[round(t*1000) for t in iois(kick)]}  (expect ~508 then ~455)")

print("=" * 72)
# STEP 7: prophet + bd_haus
L, R = load("step7-bundled.wav")
print(f"STEP 7 bundled: dur={len(L)/SR:.1f}s  (prophet@~0.3s, bd_haus@~2.3s and ~4.3s)")
for a, b, tag in [(0.5, 2.0, "prophet"), (2.3, 2.9, "bd_haus#1"), (4.3, 4.9, "bd_haus#2")]:
    s = slice(int(a * SR), int(b * SR))
    print(f"  {tag:10s} RMS L={rms(L[s]):.4f} R={rms(R[s]):.4f}")
hits = onsets(L, band=(30, 200), thresh_ratio=0.4, min_gap_ms=300)
print(f"  low-band transients: {hits}")

print("=" * 72)
# STEP 8: pstop tail vs (stop)
L, R = load("step8-stop.wav")
print(f"STEP 8 stop: dur={len(L)/SR:.1f}s  (timeline: (stop)@~0.3, dense loop@~1.8, pstop@~4.8, dense2@~6.3, (stop)@~8.8)")
e, spb = envelope(L)
for a, b, tag in [(3.0, 4.8, "dense running"), (4.9, 6.2, "after pstop"), (7.5, 8.7, "after (stop)"), (9.3, 12.5, "final")]:
    s = slice(int(a * SR), int(b * SR))
    print(f"  {tag:14s} [{a:.1f}-{b:.1f}s] RMS={rms(L[s]):.5f}  peak={np.abs(L[s]).max():.4f}")
# find last audible moment
active = np.where(e > 0.004)[0]
if len(active):
    print(f"  last sample above 0.004 env: {active[-1]*spb:.2f}s")

print("=" * 72)
print("L/R balance summary (whole files):")
for n in ["step1-seed.wav", "step5b-pdef.wav", "step6-tempo.wav", "step7-bundled.wav"]:
    L, R = load(n)
    rl, rr = rms(L), rms(R)
    print(f"  {n:22s} RMS L={rl:.4f} R={rr:.4f} diff={20*np.log10(max(rl,rr)/max(min(rl,rr),1e-9)):.2f} dB")
