"""Station plinth, LINQ-like: a 20 mm light-grey HPL top (3 mm radius, yellow nosing inlaid at the
front), a 2 mm shadow gap, a graphite frame, a 60 x 40 kick recess on 4 levelling feet, and on the
front face the riveted fiducial, the opal LED channel (sub-object `led`) and the station plate.
Frame: the station at the floor (anchor decor_tag_<id>), mm; x ±w/2, y 0..d, z 0..T is the collision
box, trims stand <= 3 mm proud."""
import _bl as B
import _hw as H
import _kit as K

ROLE = "fixture"

TAGS = {"lh": ["1011", "0110", "1100", "0101"], "inc": ["0110", "1011", "0011", "1101"],
        "reader": ["1101", "0100", "1011", "0110"]}
PLATE = {"lh": "S1", "inc": "S2", "reader": "S3"}
NOSING = 10.0
TOP = 20.0
GAP = 2.0


def slab(w, d, z0, z1, r=3.0):
    """the HPL top: a 3 mm radius on every outer edge, the front NOSING mm inlaid in hazard yellow"""
    return [K.span(-w / 2, w / 2, 0, NOSING, z0, z1, "hazard_yellow", r, 3, sharp=("y", NOSING)),
            K.span(-w / 2, w / 2, NOSING, d, z0, z1, "plinth_top", r, 3, sharp=("y", NOSING))]


def rivet(at):
    return K.lathe([(0, 0), (2.0, 0), (1.9, 0.5), (1.2, 0.95), (0, 1.05)], K.nseg(12), "alu").moved(K.FACE_Y, at)


def build(ctx):
    sid = B.sid_of(ctx)
    st = B.station(ctx, sid)
    T, w, d = st["T"], st["w"], st["d"]
    m = B.Model(ctx, ctx.name)
    m.origin["led"] = B.item_at(ctx, "anim_%s_strip_0" % sid, T)
    zt = T - TOP
    m.add(*slab(w, d, zt, T))
    # shadow gap core and the graphite frame
    m.add(K.span(-w / 2 + 3, w / 2 - 3, 3, d - 3, zt - GAP - 0.5, zt + 0.5, "kick_dark", bev=0))
    m.add(K.span(-w / 2, w / 2, 0, d, 60, zt - GAP, "frame_dark", bev=2.0, seg=2))
    # kick recess and feet
    m.add(K.span(-w / 2 + 40, w / 2 - 40, 40, d - 40, 14, 60.5, "kick_dark", bev=1.0, seg=1))
    for sx in (-1, 1):
        for y in (22, d - 22):
            m.add(H.foot_levelling(40, 60.5).moved(t=(sx * (w / 2 - 22), y, 0)))
    # front face: fiducial on an alu-composite plate with 4 rivets
    m.add(K.span(-35, 35, -1.5, 0, 95, 165, "alu", bev=0.8, seg=2))
    tag = H.fiducial(TAGS.get(sid, TAGS["lh"]), 10.0, lift=0.12).moved(K.FACE_Y, (0, -1.5, 130))
    m.add(tag)
    for x in (-31, 31):
        for z in (99, 161):
            m.add(rivet((x, -1.5, z)))
    hs, df = H.led_bar(120, 12, "led_off", "alu", depth=2.6, lip=3.0)
    m.add(hs.moved(t=(0, 0, 176)))
    m.add(df.moved(t=(0, 0, 176)), sub="led")
    # the engraved station plate and an asset sticker on the right side
    m.add(K.span(100, 180, -1.0, 0, 120, 140, "alu_brushed", bev=0.4, seg=1))
    m.add(K.text(PLATE.get(sid, sid.upper()), 11, "label_ink", web_keep=True).moved(K.FACE_Y, (140, -1.03, 125.5)))
    seed = sum(map(ord, sid))
    m.add(H.label_plate(30, 15, "label").moved(K.rot("z", 90), (w / 2, 60, 225)))
    m.add(H.matrix_code(10, 0.8, seed, "label_ink").moved(K.FACE["+x"], (w / 2 + 0.16, 51, 225)))
    m.add(K.text("A-%03d" % (seed % 1000), 3.2, "label_ink").moved(K.FACE["+x"], (w / 2 + 0.16, 65, 223.5)))
    return m.finish(tint=("led",))
