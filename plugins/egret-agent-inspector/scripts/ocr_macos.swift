import Foundation
import Vision
import ImageIO

struct Region: Codable {
    let id: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct Spec: Codable {
    let image: String
    let regions: [Region]
    let languages: [String]
}

struct Match: Codable {
    let id: String
    let text: String
    let confidence: Float
}

struct Output: Codable {
    let matches: [Match]
}

func recognize(specPath: String, accurate: Bool) throws -> Output {
    let specURL = URL(fileURLWithPath: specPath)
    let spec = try JSONDecoder().decode(Spec.self, from: Data(contentsOf: specURL))
    let imageURL = URL(fileURLWithPath: spec.image)
    guard let source = CGImageSourceCreateWithURL(imageURL as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw NSError(domain: "EgretOCR", code: 1, userInfo: [NSLocalizedDescriptionKey: "cannot decode image"])
    }
    let sourceWidth = Double(image.width), sourceHeight = Double(image.height)
    var requests: [VNRecognizeTextRequest] = []
    for region in spec.regions {
        let x = max(0, min(sourceWidth, region.x)), y = max(0, min(sourceHeight, region.y))
        let width = max(1, min(sourceWidth - x, region.width)), height = max(1, min(sourceHeight - y, region.height))
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = accurate ? .accurate : .fast
        request.usesLanguageCorrection = true
        request.recognitionLanguages = spec.languages
        request.regionOfInterest = CGRect(x: x / sourceWidth,
                                          y: 1.0 - (y + height) / sourceHeight,
                                          width: width / sourceWidth,
                                          height: height / sourceHeight)
        requests.append(request)
    }
    try VNImageRequestHandler(cgImage: image, options: [:]).perform(requests)
    var matches: [Match] = []
    for (index, request) in requests.enumerated() {
        let candidates = (request.results ?? []).compactMap { $0.topCandidates(1).first }
        matches.append(Match(id: spec.regions[index].id,
                             text: candidates.map { $0.string }.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines),
                             confidence: candidates.map { $0.confidence }.max() ?? 0))
    }
    return Output(matches: matches)
}

func writeLine<T: Encodable>(_ value: T) throws {
    var data = try JSONEncoder().encode(value)
    data.append(0x0A)
    FileHandle.standardOutput.write(data)
}

if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--daemon" {
    let warm = CGContext(data: nil, width: 32, height: 32, bitsPerComponent: 8, bytesPerRow: 128,
                         space: CGColorSpaceCreateDeviceRGB(),
                         bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!.makeImage()!
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    try VNImageRequestHandler(cgImage: warm).perform([request])
    FileHandle.standardOutput.write(Data("{\"ready\":true}\n".utf8))
    while let path = readLine() {
        do {
            try writeLine(recognize(specPath: path, accurate: true))
        } catch {
            let message = String(describing: error).replacingOccurrences(of: "\"", with: "'")
            FileHandle.standardOutput.write(Data("{\"error\":\"\(message)\"}\n".utf8))
        }
    }
} else if CommandLine.arguments.count == 2 {
    // fast 模式几乎认不出中文（标注集命中率 <1%），一次性调用也走 accurate
    try writeLine(recognize(specPath: CommandLine.arguments[1], accurate: true))
} else {
    fputs("usage: ocr_macos <spec.json>|--daemon\n", stderr)
    exit(2)
}
