"""Cycles node graphs for looks.py specs: roughness variation, smudges, bumps (orange peel, FDM layer
lines along the part's print axis, height maps), bevel, the sheet-vinyl floor, the servo label, the
omniwheel rollers, cap knurls, emission and liquid absorption.

Per-object vectors come from custom properties read by Attribute (Object) nodes, set by build.py:
rps_pz (print axis), rps_n / rps_u / rps_h / rps_c (servo box frame), rps_ax / rps_r / rps_c (wheel).
"""
import bpy

import detail
import looks

TAU = 6.283185307


class Graph:
    def __init__(self, mt):
        self.mt, self.N, self.L = mt, mt.node_tree.nodes, mt.node_tree.links
        self.bsdf = self.N.get("Principled BSDF")
        self.out = self.N.get("Material Output")
        self.obj = self.N.new("ShaderNodeObjectInfo")
        self.tc = self.N.new("ShaderNodeTexCoord")
        self.nrm = None

    # plumbing
    def link(self, a, b):
        self.L.new(a, b)

    def node(self, kind, **kw):
        n = self.N.new(kind)
        for k, v in kw.items():
            setattr(n, k, v)
        return n

    def math(self, op, a, b=None, c=None):
        n = self.node("ShaderNodeMath", operation=op)
        for i, v in enumerate((a, b, c)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                self.link(v, n.inputs[i])
        return n.outputs[0]

    def vmath(self, op, a, b=None):
        n = self.node("ShaderNodeVectorMath", operation=op)
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (tuple, list)):
                n.inputs[i].default_value = v
            else:
                self.link(v, n.inputs[i])
        return n.outputs["Value"] if op in ("DOT_PRODUCT", "LENGTH", "DISTANCE") else n.outputs["Vector"]

    def attr(self, name):
        return self.node("ShaderNodeAttribute", attribute_type="OBJECT", attribute_name=name)

    def mix(self, fac, a, b, kind="RGBA"):
        n = self.node("ShaderNodeMix", data_type=kind)
        i = {"RGBA": (6, 7, 2), "FLOAT": (2, 3, 0)}[kind]
        out = {"RGBA": 2, "FLOAT": 0}[kind]
        self.link(fac, n.inputs[0]) if not isinstance(fac, (int, float)) else setattr(n.inputs[0], "default_value", fac)
        for sock, v in ((n.inputs[i[0]], a), (n.inputs[i[1]], b)):
            if isinstance(v, (int, float)):
                sock.default_value = v
            elif isinstance(v, (tuple, list)):
                sock.default_value = (*v[:3], 1.0)
            else:
                self.link(v, sock)
        return n.outputs[out]

    def coords(self, scale_m=1.0):
        mp = self.node("ShaderNodeMapping")
        mp.inputs["Scale"].default_value = (1 / scale_m,) * 3
        self.link(self.tc.outputs["Object"], mp.inputs["Vector"])
        return mp.outputs["Vector"]

    def image(self, name, role, scale_m, colour=False):
        """a box-projected cached texture's colour output (None when the asset is not fetched)"""
        p = looks.asset(name, role)
        if not p:
            print("looks: %s %s not fetched (python3 tools/render/fetch_assets.py)" % (name, role))
            return None
        im = bpy.data.images.get(p) or bpy.data.images.load(p, check_existing=True)
        if not colour:
            im.colorspace_settings.name = "Non-Color"
        t = self.node("ShaderNodeTexImage", projection="BOX", projection_blend=0.3, image=im)
        self.link(self.coords(scale_m), t.inputs["Vector"])
        return t.outputs["Color"]

    def noise(self, scale_m, detail=3.0):
        t = self.node("ShaderNodeTexNoise")
        t.inputs["Scale"].default_value, t.inputs["Detail"].default_value = 1.0, detail
        self.link(self.coords(scale_m), t.inputs["Vector"])
        return t.outputs["Fac"]

    def remap(self, v, lo, hi, a=0.0, b=1.0):
        n = self.node("ShaderNodeMapRange")
        self.link(v, n.inputs["Value"])
        n.inputs["From Min"].default_value, n.inputs["From Max"].default_value = a, b
        n.inputs["To Min"].default_value, n.inputs["To Max"].default_value = lo, hi
        return n.outputs["Result"]

    # channels
    def base(self, rgb, spec):
        col = (*rgb[:3], 1.0)
        if spec.get("floor"):
            col = self.floor_colour(rgb, spec["floor"])
        if spec.get("label"):
            col = self.servo_label(col, spec["label"])
        if spec.get("wheel"):
            col = self.mix(self.roller_mask(spec["wheel"]), col, spec["wheel"]["base"])
        if spec.get("lens"):
            col = self.mix(self.lens_mask(spec["lens"]), col, spec["lens"]["base"])
        if spec.get("lot"):
            col = detail.lot(self, spec, col)
        if isinstance(spec.get("layer"), dict) and (spec["layer"].get("band_albedo") or spec["layer"].get("layer_albedo")):
            col = detail.band_colour(self, spec, col)
        if spec.get("print"):
            col = detail.fine_print(self, spec["print"], col)
        if spec.get("pcb"):
            col = detail.pcb(self, spec["pcb"], col)
        if spec.get("wear"):
            col = detail.wear_colour(self, spec, col)
        if isinstance(col, tuple):
            self.bsdf.inputs["Base Color"].default_value = col
        else:
            self.link(col, self.bsdf.inputs["Base Color"])

    def scalars(self, spec):
        B = self.bsdf.inputs
        B["Metallic"].default_value = spec.get("metal", 0.0)
        B["IOR"].default_value = spec.get("ior", 1.5)
        if spec.get("transmission"):
            B["Transmission Weight"].default_value = spec["transmission"]
        if spec.get("thin_wall"):
            B["Thin Wall"].default_value = True
        if spec.get("coat"):
            B["Coat Weight"].default_value = spec["coat"]
            B["Coat Roughness"].default_value = spec.get("coat_rough", 0.08)
        if spec.get("sss"):
            B["Subsurface Weight"].default_value = spec["sss"]
            B["Subsurface Radius"].default_value = (1.0, 0.9, 0.8)
            B["Subsurface Scale"].default_value = spec.get("sss_mm", 0.5) * 0.001
        if spec.get("sheen"):
            B["Sheen Weight"].default_value = spec["sheen"]
            B["Sheen Roughness"].default_value = spec.get("sheen_rough", 0.5)
        if spec.get("aniso"):
            B["Anisotropic"].default_value = spec["aniso"]
        if spec.get("thin_film_nm"):
            B["Thin Film Thickness"].default_value = spec["thin_film_nm"]
            B["Thin Film IOR"].default_value = 1.38

    def roughness(self, spec):
        r = spec.get("rough", 0.5)
        v, rv = None, spec.get("rough_var") or (spec.get("floor") or {}).get("rough_map")
        if rv and rv.get("map"):
            img = self.image(rv["map"], "var", rv.get("scale_m", 1.0))
            v = self.remap(img, *rv["range"]) if img else None
        elif rv:
            v = self.remap(self.noise(rv.get("noise_m", 0.05)), *rv["range"], 0.3, 0.7)
        ly = spec.get("layer") if isinstance(spec.get("layer"), dict) else {}
        if ly.get("rough_amp") or ly.get("band_rough") or any(spec.get(k) for k in ("infill", "lot", "seam")):
            v = detail.print_rough(self, spec, v if v is not None else r)
        if spec.get("edge"):
            v = detail.panel_edge(self, spec["edge"], v if v is not None else r)
        tr = (spec.get("floor") or {}).get("traffic")
        if tr:                          # traffic polish along the lanes and turn circles
            v = self.mix(self.math("MULTIPLY", detail.traffic(self, tr)[0], tr.get("amount", 0.8)), v if v is not None else r, tr["rough"], "FLOAT")
        if spec.get("wear"):
            v = detail.wear_rough(self, spec, v if v is not None else r)
        if spec.get("wheel"):
            v = self.mix(self.roller_mask(spec["wheel"]), v if v is not None else r, spec["wheel"]["rough"], "FLOAT")
        if spec.get("lens"):
            v = self.mix(self.lens_mask(spec["lens"]), v if v is not None else r, spec["lens"]["rough"], "FLOAT")
        sm = spec.get("smudge")
        if sm:
            m = self.image(sm["map"], "mask", sm.get("scale_m", 0.3))
            if m:
                fac = self.math("MULTIPLY", m, sm.get("amount", 1.0))
                if sm.get("zone"):
                    fac = self.math("MULTIPLY", fac, detail.zone(self, sm["zone"]))
                v = self.mix(fac, v if v is not None else r, sm["rough"], "FLOAT")
        if v is None:
            self.bsdf.inputs["Roughness"].default_value = r
        else:
            self.link(v, self.bsdf.inputs["Roughness"])

    def emission(self, rgb, strength):
        B = self.bsdf.inputs
        if rgb == "object":
            self.link(self.obj.outputs["Color"], B["Emission Color"])
        else:
            B["Emission Color"].default_value = (*rgb[:3], 1.0)
        B["Emission Strength"].default_value = strength

    def tint(self, gain, gate=None, off=None):
        """emission = the object colour x its alpha x gain; gate [lo, hi] ramps it in over the colour's
        luminance (an idle colour stays dark), and the base goes from `off` to the colour with it"""
        s = self.math("MULTIPLY", self.obj.outputs["Alpha"], gain)
        if gate:
            bw = self.node("ShaderNodeRGBToBW")
            self.link(self.obj.outputs["Color"], bw.inputs["Color"])
            f = self.node("ShaderNodeMapRange", clamp=True)
            self.link(bw.outputs["Val"], f.inputs["Value"])
            f.inputs["From Min"].default_value, f.inputs["From Max"].default_value = gate[0], gate[1]
            s = self.math("MULTIPLY", s, f.outputs["Result"])
            if off is not None:
                self.link(self.mix(f.outputs["Result"], off, self.obj.outputs["Color"]), self.bsdf.inputs["Base Color"])
        self.link(self.obj.outputs["Color"], self.bsdf.inputs["Emission Color"])
        self.link(s, self.bsdf.inputs["Emission Strength"])

    def volume(self, v):
        n = self.node("ShaderNodeVolumeAbsorption")
        n.inputs["Color"].default_value = (*v["color"], 1.0)
        n.inputs["Density"].default_value = v.get("density", 100.0)
        self.link(n.outputs[0], self.out.inputs["Volume"])

    # normals: bumps chained, then the bevel
    def bump(self, height, dist_m, strength=1.0):
        b = self.node("ShaderNodeBump")
        b.inputs["Strength"].default_value, b.inputs["Distance"].default_value = strength, dist_m
        self.link(height, b.inputs["Height"])
        if self.nrm is not None:
            self.link(self.nrm, b.inputs["Normal"])
        self.nrm = b.outputs["Normal"]

    def normal(self, spec):
        bp = spec.get("bump")
        if bp:
            self.bump(self.noise(bp["mm"] * 0.001 * 4, 2.0), bp["amp_mm"] * 0.001)
        ly = spec.get("layer")
        if ly:
            ly = ly if isinstance(ly, dict) else {}
            self.bump(self.layer_wave(ly.get("pitch_mm", 0.2), ly.get("band_mm", 0.0), ly.get("band", 0.0)),
                      ly.get("amp_mm", 0.02) * 0.001 * looks.CONF["relief_gain"])
        for h, dist in detail.print_bumps(self, spec):
            self.bump(h, dist * looks.CONF["relief_gain"])
        if getattr(self, "pcb_relief", None) is not None:
            self.bump(self.pcb_relief, 0.00003)
        if spec.get("knurl"):
            self.bump(self.knurl(spec["knurl"]), 0.00015)
        hm = spec.get("height") or (spec.get("wheel") or {}).get("height")
        if hm:
            img = self.image(hm["map"], "height", hm.get("scale_m", 0.5))
            if img:
                self.bump(img, 0.0005, hm.get("strength", 0.1))
        if spec.get("bevel_mm"):
            bv = self.node("ShaderNodeBevel", samples=4)
            bv.inputs["Radius"].default_value = spec["bevel_mm"] * 0.001
            if self.nrm is not None:
                self.link(self.nrm, bv.inputs["Normal"])
            self.nrm = bv.outputs["Normal"]
        if self.nrm is not None:
            self.link(self.nrm, self.bsdf.inputs["Normal"])

    def layer_wave(self, pitch_mm, band_mm=0.0, band=0.0):
        """sin(2 pi (p . rps_pz) / pitch) plus a per-layer wobble band (noise along the axis, period
        ~band_mm, relative weight band): layers normal to the print axis (object Z when unset)"""
        pz = self.attr("rps_pz").outputs["Vector"]
        unset = self.math("LESS_THAN", self.vmath("LENGTH", pz), 0.5)
        axis = self.mix(unset, pz, (0.0, 0.0, 1.0))
        d = self.vmath("DOT_PRODUCT", self.tc.outputs["Object"], axis)
        wave = self.math("SINE", self.math("MULTIPLY", d, TAU / (pitch_mm * 0.001)))
        if not band:
            return wave
        comb = self.node("ShaderNodeCombineXYZ")
        self.link(self.math("MULTIPLY", d, 1 / (band_mm * 0.001)), comb.inputs["X"])
        t = self.node("ShaderNodeTexNoise")
        t.inputs["Scale"].default_value, t.inputs["Detail"].default_value = 1.0, 1.0
        self.link(comb.outputs[0], t.inputs["Vector"])
        self.layer_band = t.outputs["Fac"]
        return self.math("MULTIPLY_ADD", self.math("SUBTRACT", t.outputs["Fac"], 0.5), band / 0.25, wave)

    def knurl(self, n):
        sep = self.node("ShaderNodeSeparateXYZ")
        self.link(self.tc.outputs["Object"], sep.inputs[0])
        ang = self.math("ARCTAN2", sep.outputs["Y"], sep.outputs["X"])
        side = self.node("ShaderNodeSeparateXYZ")
        self.link(self.tc.outputs["Normal"], side.inputs[0])
        wall = self.math("SUBTRACT", 1.0, self.math("ABSOLUTE", side.outputs["Z"]))
        return self.math("MULTIPLY", self.math("SINE", self.math("MULTIPLY", ang, float(n))), wall)

    # pattern colours
    def floor_colour(self, rgb, f):
        vor = self.node("ShaderNodeTexVoronoi")
        vor.inputs["Scale"].default_value = 1.0
        self.link(self.coords(f.get("fleck_mm", 3.0) * 0.001 * 1.6), vor.inputs["Vector"])
        fl = self.remap(vor.outputs["Color"], 1 - f.get("fleck_amp", 0.06), 1 + f.get("fleck_amp", 0.06))
        mo = self.remap(self.noise(f.get("mottle_m", 0.9), 2.0), 1 - f.get("mottle_amp", 0.025), 1 + f.get("mottle_amp", 0.025), 0.3, 0.7)
        k = self.math("MULTIPLY", fl, mo)
        col = self.node("ShaderNodeMix", data_type="RGBA", blend_type="MULTIPLY")
        col.inputs[0].default_value = 1.0
        col.inputs[6].default_value = (*rgb[:3], 1.0)
        comb = self.node("ShaderNodeCombineColor")
        for i in range(3):
            self.link(k, comb.inputs[i])
        self.link(comb.outputs[0], col.inputs[7])
        # heat-welded seams: a 3 mm rod every seam_m along y
        sep = self.node("ShaderNodeSeparateXYZ")
        self.link(self.tc.outputs["Object"], sep.inputs[0])
        w = f.get("seam_mm", 3.0) * 0.001
        y = self.math("PINGPONG", self.math("ADD", sep.outputs["Y"], f.get("seam_m", 2.0) / 2), f.get("seam_m", 2.0) / 2)
        seam = self.math("LESS_THAN", self.math("SUBTRACT", f.get("seam_m", 2.0) / 2, y), w / 2)
        out = self.mix(seam, col.outputs[2], f.get("seam", (0.4, 0.41, 0.4)))
        sc = detail.traffic(self, f["traffic"])[1] if f.get("traffic") else None
        return self.mix(self.math("MULTIPLY", sc, f["traffic"].get("scuff", 0.06)), out, (0.03, 0.03, 0.03)) if sc is not None else out

    def _local(self, centre="rps_c"):
        return self.vmath("SUBTRACT", self.tc.outputs["Object"], self.attr(centre).outputs["Vector"])

    def servo_label(self, col, lb):
        """a logo-free silver label with black text blocks on the +n face of the servo's box frame"""
        p = self._local()
        n, u = self.attr("rps_n").outputs["Vector"], self.attr("rps_u").outputs["Vector"]
        h = self.node("ShaderNodeSeparateXYZ")
        self.link(self.attr("rps_h").outputs["Vector"], h.inputs[0])
        v = self.vmath("CROSS_PRODUCT", n, u)
        dn, du, dv = (self.vmath("DOT_PRODUCT", p, a) for a in (n, u, v))
        on = self.math("GREATER_THAN", dn, self.math("SUBTRACT", h.outputs["X"], 0.0006))
        inu = self.math("LESS_THAN", self.math("ABSOLUTE", du), lb["w_mm"] * 0.0005)
        inv = self.math("LESS_THAN", self.math("ABSOLUTE", dv), lb["h_mm"] * 0.0005)
        mask = self.math("MULTIPLY", self.math("MULTIPLY", on, inu), inv)
        self.label_mask = mask
        line = self.math("MULTIPLY", dv, 1 / 0.0022)
        rows = self.math("LESS_THAN", self.math("FRACT", line), 0.42)
        comb = self.node("ShaderNodeCombineXYZ")
        self.link(self.math("MULTIPLY", du, 350.0), comb.inputs["X"])
        self.link(self.math("MULTIPLY", self.math("FLOOR", line), 7.3), comb.inputs["Y"])
        t = self.node("ShaderNodeTexNoise")
        t.inputs["Scale"].default_value, t.inputs["Detail"].default_value = 1.0, 0.0
        self.link(comb.outputs[0], t.inputs["Vector"])
        words = self.math("GREATER_THAN", t.outputs["Fac"], 0.47)
        edge = self.math("LESS_THAN", self.math("ABSOLUTE", du), lb["w_mm"] * 0.0004)
        ink = self.math("MULTIPLY", self.math("MULTIPLY", rows, words), edge)
        label = self.mix(ink, lb["base"], lb["ink"])
        self.mix_scalar_on(mask, "Metallic", lb.get("metal", 0.0))
        return self.mix(mask, col, label)

    def mix_scalar_on(self, mask, sock, value):
        base = self.bsdf.inputs[sock].default_value
        self.link(self.mix(mask, base, value, "FLOAT"), self.bsdf.inputs[sock])

    def lens_mask(self, lz):
        """the glass disc at the barrel front: within r of the barrel axis, within depth of its front"""
        if getattr(self, "_lens", None) is not None:
            return self._lens
        p = self._local()
        n = self.attr("rps_n").outputs["Vector"]
        h = self.node("ShaderNodeSeparateXYZ")
        self.link(self.attr("rps_h").outputs["Vector"], h.inputs[0])
        dn = self.vmath("DOT_PRODUCT", p, n)
        axial = self.vmath("SCALE", n)
        self.link(dn, axial.node.inputs["Scale"])
        r = self.vmath("LENGTH", self.vmath("SUBTRACT", p, axial))
        front = self.math("GREATER_THAN", dn, self.math("SUBTRACT", h.outputs["X"], lz.get("depth_mm", 1.5) * 0.001))
        self._lens = self.math("MULTIPLY", front, self.math("LESS_THAN", r, lz.get("r_mm", 5.0) * 0.001))
        if lz.get("thin_film_nm"):
            self.link(self.mix(self._lens, 0.0, lz["thin_film_nm"], "FLOAT"), self.bsdf.inputs["Thin Film Thickness"])
            self.bsdf.inputs["Thin Film IOR"].default_value = 1.38
        return self._lens

    def roller_mask(self, w):
        if getattr(self, "_roller", None) is not None:
            return self._roller
        p = self._local()
        ax = self.attr("rps_ax").outputs["Vector"]
        axial = self.vmath("SCALE", ax)
        self.link(self.vmath("DOT_PRODUCT", p, ax), axial.node.inputs["Scale"])
        r = self.vmath("LENGTH", self.vmath("SUBTRACT", p, axial))
        R = self.attr("rps_r").outputs["Fac"]
        self._roller = self.math("GREATER_THAN", r, self.math("MULTIPLY", R, w.get("roller_from", 0.78)))
        return self._roller
