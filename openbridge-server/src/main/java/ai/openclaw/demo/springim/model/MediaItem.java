package ai.openclaw.demo.springim.model;

public record MediaItem(
        String kind,
        String url,
        String fileName,
        String mimeType,
        Long size
) {
}
