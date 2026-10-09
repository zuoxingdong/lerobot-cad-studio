import xml.etree.ElementTree as ET, numpy as np, trimesh, os
from fk import rpy,T
def parse_full(path='LeKiwi.urdf'):
    root=ET.parse(path).getroot(); J=[]
    for j in root.findall('joint'):
        o=j.find('origin'); a=j.find('axis')
        xyz=np.array([float(v) for v in (o.get('xyz') or '0 0 0').split()])
        r=[float(v) for v in (o.get('rpy') or '0 0 0').split()]
        ax=np.array([float(v) for v in (a.get('xyz').split())]) if a is not None else np.array([0,0,1.])
        J.append(dict(name=j.get('name'),type=j.get('type'),parent=j.find('parent').get('link'),
                      child=j.find('child').get('link'),M=T(xyz,rpy(*r)),axis=ax))
    V={}
    for l in root.findall('link'):
        for v in l.findall('.//visual'):
            g=v.find('.//mesh')
            if g is None: continue
            o=v.find('origin')
            xyz=np.array([float(x) for x in (o.get('xyz') or '0 0 0').split()])
            r=[float(x) for x in (o.get('rpy') or '0 0 0').split()]
            V[l.get('name')]=(g.get('filename').split('/')[-1],T(xyz,rpy(*r)))
    return J,V
def axis_rot(ax,th):
    ax=ax/np.linalg.norm(ax); c,s=np.cos(th),np.sin(th); x,y,z=ax
    R=np.array([[c+x*x*(1-c),x*y*(1-c)-z*s,x*z*(1-c)+y*s],
                [y*x*(1-c)+z*s,c+y*y*(1-c),y*z*(1-c)-x*s],
                [z*x*(1-c)-y*s,z*y*(1-c)+x*s,c+z*z*(1-c)]])
    M=np.eye(4); M[:3,:3]=R; return M
def fk_q(J,q,root='base_plate_layer1-v5'):
    pose={root:np.eye(4)}
    for _ in range(len(J)+2):
        for j in J:
            if j['parent'] in pose and j['child'] not in pose:
                M=j['M']
                if j['type'] in ('continuous','revolute') and j['name'] in q:
                    M=M@axis_rot(j['axis'],np.radians(q[j['name']]))
                pose[j['child']]=pose[j['parent']]@M
    return pose
