/// <reference lib="webworker" />

import {
  FaceDetector,
  FilesetResolver,
  ObjectDetector,
  PoseLandmarker,
  type Detection,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";

type InitMessage = {
  type: "init";
  baseUrl: string;
};

type FrameMessage = {
  type: "frame";
  frame: ImageBitmap;
  timestamp: number;
};

type WorkerMessage = InitMessage | FrameMessage;

type PlainDetection = {
  boundingBox?: {
    originX: number;
    originY: number;
    width: number;
    height: number;
  };
  categoryName: string;
  displayName: string;
  score: number;
};

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

let poseLandmarker: PoseLandmarker | null = null;
let faceDetector: FaceDetector | null = null;
let objectDetector: ObjectDetector | null = null;
let lastObjectDetectionAt = -Infinity;
let cachedObjects: PlainDetection[] = [];

function serializeDetections(detections: Detection[]): PlainDetection[] {
  return detections.map((detection) => {
    const category = detection.categories[0];
    return {
      boundingBox: detection.boundingBox
        ? {
            originX: detection.boundingBox.originX,
            originY: detection.boundingBox.originY,
            width: detection.boundingBox.width,
            height: detection.boundingBox.height,
          }
        : undefined,
      categoryName: category?.categoryName || "object",
      displayName: category?.displayName || category?.categoryName || "object",
      score: category?.score || 0,
    };
  });
}

function serializePoses(poses: NormalizedLandmark[][]) {
  return poses.map((pose) =>
    pose.map((point) => ({
      x: point.x,
      y: point.y,
      z: point.z,
      visibility: point.visibility ?? 0,
    })),
  );
}

async function initialize(baseUrl: string) {
  const vision = await FilesetResolver.forVisionTasks(
    `${baseUrl}/mediapipe/wasm`,
    true,
  );

  const [pose, face, objects] = await Promise.all([
    PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: `${baseUrl}/models/pose_landmarker_lite.task`,
        delegate: "CPU",
      },
      runningMode: "VIDEO",
      numPoses: 2,
      minPoseDetectionConfidence: 0.52,
      minPosePresenceConfidence: 0.52,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false,
    }),
    FaceDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: `${baseUrl}/models/blaze_face_full_range.tflite`,
        delegate: "CPU",
      },
      runningMode: "VIDEO",
      minDetectionConfidence: 0.45,
      minSuppressionThreshold: 0.3,
    }),
    ObjectDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: `${baseUrl}/models/efficientdet_lite0_uint8.tflite`,
        delegate: "CPU",
      },
      runningMode: "VIDEO",
      scoreThreshold: 0.45,
      maxResults: 10,
    }),
  ]);

  poseLandmarker = pose;
  faceDetector = face;
  objectDetector = objects;
  workerScope.postMessage({ type: "ready" });
}

function analyzeFrame(message: FrameMessage) {
  const { frame, timestamp } = message;
  if (!poseLandmarker || !faceDetector || !objectDetector) {
    frame.close();
    return;
  }

  const startedAt = performance.now();
  try {
    const poseResult = poseLandmarker.detectForVideo(frame, timestamp);
    const faceResult = faceDetector.detectForVideo(frame, timestamp);
    let objectUpdated = false;

    if (timestamp - lastObjectDetectionAt >= 850) {
      const objectResult = objectDetector.detectForVideo(frame, timestamp);
      cachedObjects = serializeDetections(objectResult.detections);
      lastObjectDetectionAt = timestamp;
      objectUpdated = true;
    }

    workerScope.postMessage({
      type: "result",
      timestamp,
      frameWidth: frame.width,
      frameHeight: frame.height,
      poses: serializePoses(poseResult.landmarks),
      faces: serializeDetections(faceResult.detections),
      objects: cachedObjects,
      objectUpdated,
      latencyMs: performance.now() - startedAt,
    });
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      message:
        error instanceof Error
          ? `AI 분석 오류: ${error.message}`
          : "AI 분석 중 오류가 발생했습니다.",
    });
  } finally {
    frame.close();
  }
}

workerScope.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  if (event.data.type === "init") {
    try {
      await initialize(event.data.baseUrl);
    } catch (error) {
      workerScope.postMessage({
        type: "error",
        message:
          error instanceof Error
            ? `AI 모델 준비 실패: ${error.message}`
            : "AI 모델을 준비하지 못했습니다.",
      });
    }
    return;
  }

  analyzeFrame(event.data);
};
