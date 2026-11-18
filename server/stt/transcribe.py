"""Transcribe one recording for an Agent Worlds voice capture.

    transcribe.py <audio> <out.json>

Writes {"text", "language", "duration", "device"}. Uses faster-whisper large-v3-turbo: on the GPU (int8_float16,
about 1.5 GB) when it has room, otherwise on the CPU (int8, 16 threads). A GPU that runs out of memory mid-way
(another app took it) falls back to the CPU once. Needs: pip install faster-whisper nvidia-cublas-cu12 'nvidia-cudnn-cu12==9.*'
"""
import json
import os
import subprocess
import sys

MODEL = "large-v3-turbo"
GPU_FREE_MIB = 1600
CPU_THREADS = 16  # more threads measured slower on this 80-core box


def cuda_lib_dirs():
    try:
        import nvidia.cublas
        import nvidia.cudnn
    except ImportError:
        return []
    return [os.path.join(p, "lib") for m in (nvidia.cublas, nvidia.cudnn) for p in m.__path__]


def ensure_cuda_libs():
    """The CUDA loader reads LD_LIBRARY_PATH only at start-up, so set it and run again."""
    dirs = cuda_lib_dirs()
    have = os.environ.get("LD_LIBRARY_PATH", "").split(":")
    if dirs and not all(d in have for d in dirs):
        env = dict(os.environ, LD_LIBRARY_PATH=":".join(dirs + [p for p in have if p]))
        os.execve(sys.executable, [sys.executable, *sys.argv], env)


def gpu_free_mib():
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=10).stdout
        return max(int(x) for x in out.split())
    except Exception:
        return 0


def run(audio, device):
    from faster_whisper import WhisperModel
    if device == "cuda":
        model = WhisperModel(MODEL, device="cuda", compute_type="int8_float16")
    else:
        model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=CPU_THREADS)
    segments, info = model.transcribe(audio, vad_filter=True, beam_size=5)
    text = " ".join(s.text.strip() for s in segments)  # segments is lazy: the work happens here
    return {"text": text, "language": info.language, "duration": info.duration, "device": device}


def main():
    audio, out = sys.argv[1], sys.argv[2]
    ensure_cuda_libs()
    device = "cuda" if cuda_lib_dirs() and gpu_free_mib() >= GPU_FREE_MIB else "cpu"
    try:
        result = run(audio, device)
    except Exception as e:  # CUDA out of memory, or the driver went away
        if device != "cuda":
            raise
        print(f"GPU failed ({e}); using the CPU", file=sys.stderr)
        result = run(audio, "cpu")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)


if __name__ == "__main__":
    main()
