import cv2
import numpy as np
import io
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional

app = FastAPI(title="Floor Plan Vision API")

# Allow CORS for the frontend (Vite default port is 5173)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Adjust in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class BBox(BaseModel):
    x: float
    y: float
    w: float
    h: float

class Room(BaseModel):
    id: str
    name: str
    confidence: str
    bbox: BBox
    estimatedWidthM: float
    estimatedDepthM: float
    wallHeightM: float

class WallSegment(BaseModel):
    id: str
    x1: float
    y1: float
    x2: float
    y2: float
    type: str
    thicknessRatio: float

class Door(BaseModel):
    id: str
    bbox: BBox
    widthM: float

class Window(BaseModel):
    id: str
    bbox: BBox
    widthM: float

class DetectionResult(BaseModel):
    summary: str
    rooms: List[Room]
    walls: List[WallSegment]
    doors: List[Door]
    windows: List[Window]

def detect_walls_opencv(image_bytes: bytes) -> List[WallSegment]:
    # 1. Read image from bytes
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    
    if img is None:
        raise ValueError("Could not decode image")
        
    height, width = img.shape[:2]
    
    # 2. Preprocess: Grayscale
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    
    # 3. Enhance contrast & blur slightly to remove noise
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    
    # 4. Edge Detection (Canny)
    # The thresholds might need tuning depending on the floor plan images
    edges = cv2.Canny(blurred, 50, 150, apertureSize=3)
    
    # 5. Line Detection using Probabilistic Hough Transform
    # Adjust parameters: rho, theta, threshold, minLineLength, maxLineGap
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=100, minLineLength=50, maxLineGap=10)
    
    walls = []
    if lines is not None:
        for i, line in enumerate(lines):
            for x1, y1, x2, y2 in line:
                # Normalize coordinates to 0.0 - 1.0 (frontend expectation)
                nx1 = x1 / width
                ny1 = y1 / height
                nx2 = x2 / width
                ny2 = y2 / height
                
                # Basic assumption: thicker lines might be detected multiple times.
                # In a real app, we'd need to merge close parallel lines into a single thick "wall".
                # For now, return each detected line.
                walls.append(WallSegment(
                    id=f"w-cv-{i}",
                    x1=nx1,
                    y1=ny1,
                    x2=nx2,
                    y2=ny2,
                    type="interior",  # Simplification
                    thicknessRatio=0.01
                ))
                
    return walls

@app.post("/api/detect-floorplan", response_model=DetectionResult)
async def analyze_floor_plan(file: UploadFile = File(...)):
    """
    Endpoint that mimics the Gemini Vision API response, but uses OpenCV internally.
    """
    try:
        image_bytes = await file.read()
        walls = detect_walls_opencv(image_bytes)
        
        # Room, Door, Window detection is complex using purely traditional CV.
        # We will return empty lists for them for now to demonstrate the wall detection.
        return DetectionResult(
            summary=f"OpenCV Detection. Found {len(walls)} wall segments.",
            rooms=[],
            walls=walls,
            doors=[],
            windows=[]
        )
        
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/health")
def health_check():
    return {"status": "ok"}
