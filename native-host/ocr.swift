import Cocoa
import Vision

let args = CommandLine.arguments
guard args.count > 1 else {
    print("ERROR: Usage: ocr <image_path>")
    exit(1)
}

let path = args[1]
let url = URL(fileURLWithPath: path)
guard let image = NSImage(contentsOf: url) else {
    print("ERROR: Cannot load image from \(path)")
    exit(1)
}
guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    print("ERROR: Cannot get CGImage")
    exit(1)
}

let imgW = cgImage.width
let imgH = cgImage.height

let request = VNRecognizeTextRequest { (request, error) in
    if let error = error {
        print("ERROR: \(error.localizedDescription)")
        exit(1)
    }
    guard let observations = request.results as? [VNRecognizedTextObservation] else {
        print("[]")
        exit(0)
    }
    var results: [[String: Any]] = []
    for obs in observations {
        guard let top = obs.topCandidates(1).first else { continue }
        let rect = obs.boundingBox
        // rect is normalized (0-1), origin bottom-left
        let x = Double(rect.origin.x)
        let y = Double(rect.origin.y)
        let w = Double(rect.size.width)
        let h = Double(rect.size.height)
        results.append([
            "text": top.string,
            "confidence": Double(top.confidence),
            "x": x, "y": y, "w": w, "h": h
        ])
    }
    // Output: JSON object with image dimensions and text blocks
    let output: [String: Any] = [
        "imageWidth": imgW,
        "imageHeight": imgH,
        "blocks": results
    ]
    if let jsonData = try? JSONSerialization.data(withJSONObject: output, options: []),
       let jsonStr = String(data: jsonData, encoding: .utf8) {
        print(jsonStr)
    } else {
        print("ERROR: JSON serialization failed")
    }
}
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try? handler.perform([request])
