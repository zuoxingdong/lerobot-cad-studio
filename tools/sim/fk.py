import xml.etree.ElementTree as ET, numpy as np, os, trimesh
def rpy(r,p,y):
    cr,sr=np.cos(r),np.sin(r); cp,sp=np.cos(p),np.sin(p); cy,sy=np.cos(y),np.sin(y)
    Rz=np.array([[cy,-sy,0],[sy,cy,0],[0,0,1]]); Ry=np.array([[cp,0,sp],[0,1,0],[-sp,0,cp]])
    Rx=np.array([[1,0,0],[0,cr,-sr],[0,sr,cr]]); return Rz@Ry@Rx
def T(xyz,r):
    M=np.eye(4); M[:3,:3]=r; M[:3,3]=xyz; return M
def parse(path='LeKiwi.urdf'):
    root=ET.parse(path).getroot()
    joints=[]
    for j in root.findall('joint'):
        o=j.find('origin')
        xyz=np.array([float(v) for v in (o.get('xyz') or '0 0 0').split()])
        r=[float(v) for v in (o.get('rpy') or '0 0 0').split()]
        joints.append((j.find('parent').get('link'), j.find('child').get('link'), T(xyz,rpy(*r))))
    vis={}
    for l in root.findall('link'):
        for v in l.findall('.//visual'):
            g=v.find('.//mesh')
            if g is None: continue
            o=v.find('origin')
            xyz=np.array([float(x) for x in (o.get('xyz') or '0 0 0').split()])
            r=[float(x) for x in (o.get('rpy') or '0 0 0').split()]
            vis[l.get('name')]=(g.get('filename').split('/')[-1], T(xyz,rpy(*r)))
    return joints,vis
def fk(joints,root='base_plate_layer1-v5'):
    pose={root:np.eye(4)}
    for _ in range(len(joints)+2):
        for p,c,M in joints:
            if p in pose and c not in pose: pose[c]=pose[p]@M
    return pose
if __name__=='__main__':
    joints,vis=parse(); pose=fk(joints)
    print("links posed:",len(pose))
    got=[]
    for link,(f,Mv) in sorted(vis.items()):
        fp=os.path.join('meshes',f)
        if not os.path.exists(fp) or link not in pose: continue
        m=trimesh.load(fp)
        m.apply_scale(0.001)                 # mm -> m to match URDF
        m.apply_transform(pose[link]@Mv)
        m.apply_scale(1000.0)                # back to mm for working
        got.append((link,m))
    for link,m in got:
        print("  %-40s bbox %s .. %s"%(link,np.round(m.bounds[0],1),np.round(m.bounds[1],1)))
