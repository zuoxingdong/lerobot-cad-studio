"""The fingertip covers pressed together, as the web's coverPress (src/ui/robot-look.js): where the jaw closes past
the covers' touch (MuJoCo lets them pass, the real jaw stops), each cover is clamped to their mid-plane, EPS short
of it. A Geometry Nodes plane clamp on each cover, its plane keyed on every (sub)frame. Render only: the viewport
(ray-cast masks) keeps the free shape."""
import numpy as np

EPS = 5e-5                  # m, each side of the mid-plane
FAR = 1.0                   # the clamp offset while the covers are apart (local units)
PAIR = ("robot_kit_finger_L_follow", "robot_kit_finger_R_follow")
CHUNK = 512                 # frames per batch of the extent search


def extent(V, M, n):
    """per frame max over the local verts V (k, 3) of n . (M v); M (F, 4, 4), n (F, 3)"""
    u = np.einsum("fji,fj->fi", M[:, :3, :3], n)
    t = (M[:, :3, 3] * n).sum(1)
    return np.concatenate([(V @ u[i:i + CHUNK].T).max(0) for i in range(0, len(M), CHUNK)]) + t


def planes(VA, VB, MA, MB, eps=EPS):
    """the clamp plane of each cover per frame, in its own frame: keep u . p <= w (u unit; w = FAR while apart).
    VA, VB: local verts; MA, MB: (F, 4, 4) world matrices. Returns (uA, wA, uB, wB, on)."""
    c = [M[:, :3, :3] @ ((V.min(0) + V.max(0)) / 2) + M[:, :3, 3] for V, M in ((VA, MA), (VB, MB))]
    n = c[1] - c[0]
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    hA, hB = extent(VA, MA, n), -extent(VB, MB, -n)
    on = hA - hB > -2 * eps
    mid = (hA + hB) / 2
    out = []
    for M, s, lim in ((MA, 1.0, mid - eps), (MB, -1.0, -(mid + eps))):
        u = np.einsum("fji,fj->fi", M[:, :3, :3], s * n)        # local normal (A^T n)
        k = np.linalg.norm(u, axis=1)
        w = (lim - s * (M[:, :3, 3] * n).sum(1)) / k
        out += [u / k[:, None], np.where(on, w, FAR)]
    return (*out, on)


def group(bpy):
    """P -= u * max(u . P - w, 0)"""
    g = bpy.data.node_groups.get("rps_press")
    if g:
        return g
    g = bpy.data.node_groups.new("rps_press", "GeometryNodeTree")
    I = g.interface
    I.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    I.new_socket("Normal", in_out="INPUT", socket_type="NodeSocketVector").default_value = (0, 0, 1)
    I.new_socket("Offset", in_out="INPUT", socket_type="NodeSocketFloat").default_value = FAR
    I.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    N, L = g.nodes, g.links
    gi, go, pos, setp = (N.new(t) for t in ("NodeGroupInput", "NodeGroupOutput", "GeometryNodeInputPosition",
                                           "GeometryNodeSetPosition"))
    dot, scale = N.new("ShaderNodeVectorMath"), N.new("ShaderNodeVectorMath")
    dot.operation, scale.operation = "DOT_PRODUCT", "SCALE"
    sub, mx, neg = (N.new("ShaderNodeMath") for _ in range(3))
    sub.operation, mx.operation, neg.operation = "SUBTRACT", "MAXIMUM", "MULTIPLY"
    mx.inputs[1].default_value, neg.inputs[1].default_value = 0.0, -1.0
    L.new(pos.outputs[0], dot.inputs[0])
    L.new(gi.outputs["Normal"], dot.inputs[1])
    L.new(dot.outputs["Value"], sub.inputs[0])
    L.new(gi.outputs["Offset"], sub.inputs[1])
    L.new(sub.outputs[0], mx.inputs[0])
    L.new(mx.outputs[0], neg.inputs[0])
    L.new(gi.outputs["Normal"], scale.inputs[0])
    L.new(neg.outputs[0], scale.inputs["Scale"])
    L.new(gi.outputs["Geometry"], setp.inputs["Geometry"])
    L.new(scale.outputs["Vector"], setp.inputs["Offset"])
    L.new(setp.outputs[0], go.inputs[0])
    return g


def world(em, ob, F):
    """(F, 4, 4): the follow empty's keyed pose at frames F, times the cover's own local matrix"""
    from mathutils import Quaternion
    import prims
    if em.animation_data:                       # subst.follower keys both, or neither
        lf, qf = prims.fcurves(em, "location", 3), prims.fcurves(em, "rotation_quaternion", 4)
        loc = np.array([[fc.evaluate(f) for fc in lf] for f in F])
        quat = np.array([[fc.evaluate(f) for fc in qf] for f in F])
    else:
        loc = np.repeat(np.array(em.location)[None], len(F), 0)
        quat = np.repeat(np.array(em.rotation_quaternion)[None], len(F), 0)
    L = np.array(ob.matrix_parent_inverse) @ np.array(ob.matrix_basis)
    M = np.repeat(np.eye(4)[None], len(F), 0)
    for i, (p, q) in enumerate(zip(loc, quat)):
        M[i, :3, :3] = np.array(Quaternion(q).normalized().to_matrix())
        M[i, :3, 3] = p
    return M @ L


def apply(B):
    """add the keyed clamp to both covers; returns the frames pressed (0 without the pair)"""
    import bpy
    import prims
    E = [bpy.data.objects.get(n) for n in PAIR]
    obs = [next((c for c in e.children if c.type == "MESH"), None) if e else None for e in E]
    if None in obs:
        return 0
    F = np.asarray(B.frames, float)
    V = []
    for ob in obs:
        co = np.empty(3 * len(ob.data.vertices))
        ob.data.vertices.foreach_get("co", co)
        V.append(co.reshape(-1, 3))
    uA, wA, uB, wB, on = planes(V[0], V[1], world(E[0], obs[0], F), world(E[1], obs[1], F))
    g = group(bpy)
    for ob, u, w in ((obs[0], uA, wA), (obs[1], uB, wB)):
        m = ob.modifiers.new("press", "NODES")
        m.node_group = g
        m.show_viewport = False
        ids = {it.name: it.identifier for it in g.interface.items_tree if it.item_type == "SOCKET" and it.in_out == "INPUT"}
        prims.key(ob, 'modifiers["press"].properties.inputs.%s.value' % ids["Normal"], F, u)
        prims.key(ob, 'modifiers["press"].properties.inputs.%s.value' % ids["Offset"], F, w)
    print("press: covers pressed on %d of %d (sub)frames" % (int(on.sum()), len(F)))
    return int(on.sum())
