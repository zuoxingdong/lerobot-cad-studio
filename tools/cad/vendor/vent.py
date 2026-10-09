"""Stock-case vent field: 3.0 mm stadium slots at 45 deg, 5.90 mm perpendicular pitch."""
import numpy as np, cadquery as cq
from shapely.geometry import box, LineString, Polygon
from shapely.ops import unary_union
W,PITCH,ANG,MINLEN,TRIM = 3.0, 5.90, 45.0, 8.0, 1.5
def chords(u0,u1,v0,v1,exclude=(),grow=2.5):
    field=box(u0,v0,u1,v1)
    if exclude:
        field=field.difference(unary_union([box(a,c,b,d).buffer(grow,join_style=2) for a,b,c,d in exclude]))
    if field.is_empty: return []
    dc=PITCH*np.sqrt(2.0)                      # v = u + c ; perpendicular spacing = |dc|/sqrt(2)
    cmin,cmax=v0-u1-dc, v1-u0+dc
    out=[]
    for c in np.arange(cmin,cmax,dc):
        big=1e4
        seg=LineString([(-big,-big+c),(big,big+c)]).intersection(field)
        parts=[seg] if seg.geom_type=='LineString' else list(getattr(seg,'geoms',[]))
        for p in parts:
            if p.is_empty or p.geom_type!='LineString': continue
            L=p.length
            if L<MINLEN+2*TRIM: continue
            (x0,y0),(x1,y1)=p.coords[0],p.coords[-1]
            ux,uy=(x1-x0)/L,(y1-y0)/L
            a=(x0+ux*TRIM, y0+uy*TRIM); b=(x1-ux*TRIM, y1-uy*TRIM)
            out.append(((a[0]+b[0])/2,(a[1]+b[1])/2, L-2*TRIM))
    return out
def field_solid(u0,u1,v0,v1,depth,exclude=()):
    """slots built in the local XY plane, extruded both ways -> orientation-agnostic"""
    cs=chords(u0,u1,v0,v1,exclude)
    if not cs: return None
    wp=cq.Workplane("XY")
    for cu,cv,L in cs:
        wp=wp.moveTo(cu,cv).slot2D(L+W,W,ANG)
    return wp.extrude(depth/2.0,both=True).val()
def place(sol,face,offset):
    """map the local XY slot block onto a robot face. face in {'XZ','YZ','XY'}"""
    if sol is None: return None
    if face=='XZ':                      # u->X, v->Z, thickness along Y
        sol=sol.rotate((0,0,0),(1,0,0),90); return sol.translate((0,offset,0))
    if face=='YZ':                      # u->Y, v->Z, thickness along X
        sol=sol.rotate((0,0,0),(1,0,0),90).rotate((0,0,0),(0,0,1),90); return sol.translate((offset,0,0))
    if face=='XY':                      # u->X, v->Y, thickness along Z
        return sol.translate((0,0,offset))
    raise ValueError(face)
