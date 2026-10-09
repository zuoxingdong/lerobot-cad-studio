"""The hero framing on the repo shots.json: the puck stays in frame through the insert and the reader
placement, the e-stop post never stands in a foreground, pans stay under 10 deg/s, every eye is inside the
closed room and not facing a wall close up, and the robot reads in the establishing shot. Also the BT.709
encode of both codecs."""

from __future__ import annotations

import json
import os

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
RENDER = os.path.join(STUDIO, "tools", "render")
import capture  # noqa: E402
import framing  # noqa: E402

SHOTS = os.path.join(RENDER, "shots.json")


def test_repo_shots_frame_the_subject(lab, tmp_path):
    cap = str(tmp_path / "cap")
    capture.write(cap, *capture.capture(lab, os.path.join(lab, "ctrl.f32"), fps=30, sub=1, campath=SHOTS))
    rows = {r["shot"]: r for r in framing.analyse(cap, SHOTS, json.load(open(os.path.join(lab, "report.json"))))}
    assert set(rows) == {s["id"] for s in json.load(open(SHOTS))["shots"]}
    for sid in ("grasp", "insert", "place_reader"):
        assert rows[sid]["puck_margin"] > 0.02, rows[sid]              # never cut at the frame edge
    for r in rows.values():
        assert all(v <= 0.005 for v in r["keep_out"].values()), r     # the e-stop post: never a foreground block
        assert r["pan_deg_s"] < 10.0, r
        assert r["eye_clear_m"] > 0.1 and r["view_depth_m"] > 1.2, r     # inside the closed room, not facing a wall
    assert rows["establish"]["robot_h"] > 0.25


@pytest.mark.parametrize("codec", ["x264", "x265"])
def test_encode_is_bt709(tmp_path, codec):
    import subprocess
    import encode
    mp4 = str(tmp_path / "red.mp4")
    red = np.zeros((64, 64, 3), np.uint8)
    red[..., 0] = 255
    p = subprocess.run(getattr(encode, codec)(64, 64, 30, mp4), input=red.tobytes() * 4, capture_output=True)
    assert p.returncode == 0, p.stderr
    y = subprocess.run([encode.VID.ffmpeg_exe(), "-loglevel", "error", "-i", mp4, "-frames:v", "1", "-f", "rawvideo",
                        "-pix_fmt", "yuv420p", "-"], capture_output=True).stdout
    assert abs(np.frombuffer(y[:64 * 64], np.uint8).mean() - 63) < 3            # BT.709 limited range; BT.601 gives 81
    tags = subprocess.run([encode.VID.ffmpeg_exe(), "-i", mp4], capture_output=True, text=True).stderr
    assert "bt709" in tags
