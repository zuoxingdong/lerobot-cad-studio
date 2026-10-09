/* The three.js names site/vendor/baked-lab.js takes from the page (globalThis.RPS_THREE), so the lazy
   bundle and the page share one three; build.mjs fails when the bundle needs a name missing here. */
import {
  AnimationClip, Bone, Box3, BoxGeometry, BufferAttribute, BufferGeometry, Cache, Camera, ClampToEdgeWrapping, Color,
  ColorManagement, CompressedArrayTexture, CompressedCubeTexture, CompressedTexture, Data3DTexture,
  DataTexture, DataTextureLoader, DataUtils, DirectionalLight, DoubleSide, EquirectangularReflectionMapping,
  FileLoader, Float32BufferAttribute, FloatType, FrontSide, Group, HalfFloatType, HemisphereLight,
  ImageBitmapLoader, InstancedBufferAttribute, InstancedMesh, InterleavedBuffer, InterleavedBufferAttribute,
  Interpolant, InterpolateDiscrete, InterpolateLinear, Line, LineBasicMaterial, LineLoop, LineSegments,
  LinearFilter, LinearMipmapLinearFilter, LinearMipmapNearestFilter, LinearSRGBColorSpace, LinearTransfer,
  Loader, LoaderUtils, Material, MathUtils, Matrix3, Matrix4, Mesh, MeshBasicMaterial, MeshPhysicalMaterial,
  MeshStandardMaterial, MirroredRepeatWrapping, NearestFilter, NearestMipmapLinearFilter,
  NearestMipmapNearestFilter, NoColorSpace, NumberKeyframeTrack, Object3D, OrthographicCamera,
  PMREMGenerator, PerspectiveCamera, PointLight, Points, PointsMaterial, PropertyBinding, Quaternion,
  QuaternionKeyframeTrack, RGBAFormat, RGBA_ASTC_4x4_Format, RGBA_ASTC_6x6_Format, RGBA_BPTC_Format,
  RGBA_ETC2_EAC_Format, RGBA_PVRTC_4BPPV1_Format, RGBA_S3TC_DXT1_Format, RGBA_S3TC_DXT5_Format,
  RGB_BPTC_UNSIGNED_Format, RGB_ETC1_Format, RGB_ETC2_Format, RGB_PVRTC_4BPPV1_Format, RGFormat, RedFormat,
  RepeatWrapping, SRGBColorSpace, SRGBTransfer, ShaderChunk, Skeleton, SkinnedMesh, Sphere, SpotLight,
  Texture, TextureLoader, Triangle, TriangleFanDrawMode, TriangleStripDrawMode, TrianglesDrawMode, UnsignedByteType,
  Vector2, Vector3, Vector4, VectorKeyframeTrack
} from 'three';

export const THREE_VENDOR = {
  AnimationClip, Bone, Box3, BoxGeometry, BufferAttribute, BufferGeometry, Cache, Camera, ClampToEdgeWrapping, Color,
  ColorManagement, CompressedArrayTexture, CompressedCubeTexture, CompressedTexture, Data3DTexture,
  DataTexture, DataTextureLoader, DataUtils, DirectionalLight, DoubleSide, EquirectangularReflectionMapping,
  FileLoader, Float32BufferAttribute, FloatType, FrontSide, Group, HalfFloatType, HemisphereLight,
  ImageBitmapLoader, InstancedBufferAttribute, InstancedMesh, InterleavedBuffer, InterleavedBufferAttribute,
  Interpolant, InterpolateDiscrete, InterpolateLinear, Line, LineBasicMaterial, LineLoop, LineSegments,
  LinearFilter, LinearMipmapLinearFilter, LinearMipmapNearestFilter, LinearSRGBColorSpace, LinearTransfer,
  Loader, LoaderUtils, Material, MathUtils, Matrix3, Matrix4, Mesh, MeshBasicMaterial, MeshPhysicalMaterial,
  MeshStandardMaterial, MirroredRepeatWrapping, NearestFilter, NearestMipmapLinearFilter,
  NearestMipmapNearestFilter, NoColorSpace, NumberKeyframeTrack, Object3D, OrthographicCamera,
  PMREMGenerator, PerspectiveCamera, PointLight, Points, PointsMaterial, PropertyBinding, Quaternion,
  QuaternionKeyframeTrack, RGBAFormat, RGBA_ASTC_4x4_Format, RGBA_ASTC_6x6_Format, RGBA_BPTC_Format,
  RGBA_ETC2_EAC_Format, RGBA_PVRTC_4BPPV1_Format, RGBA_S3TC_DXT1_Format, RGBA_S3TC_DXT5_Format,
  RGB_BPTC_UNSIGNED_Format, RGB_ETC1_Format, RGB_ETC2_Format, RGB_PVRTC_4BPPV1_Format, RGFormat, RedFormat,
  RepeatWrapping, SRGBColorSpace, SRGBTransfer, ShaderChunk, Skeleton, SkinnedMesh, Sphere, SpotLight,
  Texture, TextureLoader, Triangle, TriangleFanDrawMode, TriangleStripDrawMode, TrianglesDrawMode, UnsignedByteType,
  Vector2, Vector3, Vector4, VectorKeyframeTrack
};
