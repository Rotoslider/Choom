'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { X, Download, Trash2, ChevronLeft, ChevronRight, Image as ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/utils';

interface GeneratedImage {
  id: string;
  choomId: string;
  prompt: string;
  settings: string | null;
  createdAt: string;
}

function imageFileUrl(id: string) {
  return `/api/images/${id}/file`;
}

interface ImageGalleryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  choomId: string | null;
  choomName?: string;
}

export function ImageGallery({
  open,
  onOpenChange,
  choomId,
  choomName,
}: ImageGalleryProps) {
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedImage, setSelectedImage] = useState<GeneratedImage | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);

  // Fetch images when gallery opens
  useEffect(() => {
    if (open && choomId) {
      fetchImages();
    }
  }, [open, choomId]);

  const fetchImages = async () => {
    if (!choomId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/images?choomId=${choomId}`);
      if (res.ok) {
        const data = await res.json();
        setImages(data);
      }
    } catch (error) {
      console.error('Failed to fetch images:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (imageId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!confirm('Are you sure you want to delete this image?')) return;

    try {
      const res = await fetch(`/api/images/${imageId}`, { method: 'DELETE' });
      if (res.ok) {
        const remaining = images.filter((img) => img.id !== imageId);
        setImages(remaining);

        // If deleting the lightbox image, navigate instead of closing
        if (selectedImage?.id === imageId) {
          if (remaining.length === 0) {
            setSelectedImage(null);
            setSelectedIndex(-1);
          } else {
            // Navigate to next image, or wrap to beginning if we deleted the last
            const newIndex = selectedIndex >= remaining.length ? 0 : selectedIndex;
            setSelectedIndex(newIndex);
            setSelectedImage(remaining[newIndex]);
          }
        }
      }
    } catch (error) {
      console.error('Failed to delete image:', error);
    }
  };

  const handleDownload = (image: GeneratedImage, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    // Parse settings to determine if it's a self-portrait
    let isSelfPortrait = false;
    try {
      const settings = image.settings ? JSON.parse(image.settings) : null;
      isSelfPortrait = settings?.isSelfPortrait === true;
    } catch {
      // Ignore parse errors
    }

    // Build filename: ChoomName-type-shortId.png
    const name = choomName || 'Choom';
    const type = isSelfPortrait ? 'selfie' : 'image';
    const shortId = image.id.slice(-8); // Last 8 chars of ID

    const link = document.createElement('a');
    link.href = imageFileUrl(image.id);
    link.download = `${name}-${type}-${shortId}.png`;
    link.click();
  };

  const openLightbox = (image: GeneratedImage, index: number) => {
    setSelectedImage(image);
    setSelectedIndex(index);
  };

  const closeLightbox = () => {
    setSelectedImage(null);
    setSelectedIndex(-1);
  };

  const navigateImage = useCallback((direction: 'prev' | 'next') => {
    if (images.length === 0) return;

    let newIndex: number;
    if (direction === 'prev') {
      newIndex = selectedIndex <= 0 ? images.length - 1 : selectedIndex - 1;
    } else {
      newIndex = selectedIndex >= images.length - 1 ? 0 : selectedIndex + 1;
    }

    setSelectedIndex(newIndex);
    setSelectedImage(images[newIndex]);
  }, [images, selectedIndex]);

  // Keyboard navigation in lightbox
  useEffect(() => {
    if (!selectedImage) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') navigateImage('prev');
      if (e.key === 'ArrowRight') navigateImage('next');
      if (e.key === 'Escape') closeLightbox();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedImage, navigateImage]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-4xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ImageIcon className="h-5 w-5" />
              {choomName ? `${choomName}'s Gallery` : 'Image Gallery'}
              <span className="text-sm text-muted-foreground font-normal">
                ({images.length} images)
              </span>
            </DialogTitle>
          </DialogHeader>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : images.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <ImageIcon className="h-16 w-16 text-muted-foreground/30 mb-4" />
              <p className="text-muted-foreground">No images generated yet</p>
              <p className="text-sm text-muted-foreground/70">
                Ask your Choom to generate an image to see it here
              </p>
            </div>
          ) : (
            <ScrollArea className="h-[60vh]">
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 p-1">
                {images.map((image, index) => (
                  <div
                    key={image.id}
                    className="group relative aspect-square rounded-lg overflow-hidden bg-muted cursor-pointer"
                    onClick={() => openLightbox(image, index)}
                  >
                    <img
                      src={imageFileUrl(image.id)}
                      alt={image.prompt}
                      loading="lazy"
                      className="w-full h-full object-cover transition-transform group-hover:scale-105"
                    />
                    {/* Hover overlay */}
                    <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-between p-2">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 bg-white/20 hover:bg-white/30 text-white"
                          onClick={(e) => handleDownload(image, e)}
                        >
                          <Download className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 bg-red-500/50 hover:bg-red-500/70 text-white"
                          onClick={(e) => handleDelete(image.id, e)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      <p className="text-xs text-white/80 line-clamp-2">
                        {image.prompt}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>

      {/* Lightbox */}
      {selectedImage && (
        <div
          className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center"
          onClick={closeLightbox}
        >
          {/* Close button */}
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-4 right-4 text-white hover:bg-white/20 z-10"
            onClick={closeLightbox}
          >
            <X className="h-6 w-6" />
          </Button>

          {/* Navigation buttons */}
          {images.length > 1 && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="absolute left-4 top-1/2 -translate-y-1/2 text-white hover:bg-white/20 h-12 w-12"
                onClick={(e) => {
                  e.stopPropagation();
                  navigateImage('prev');
                }}
              >
                <ChevronLeft className="h-8 w-8" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-4 top-1/2 -translate-y-1/2 text-white hover:bg-white/20 h-12 w-12"
                onClick={(e) => {
                  e.stopPropagation();
                  navigateImage('next');
                }}
              >
                <ChevronRight className="h-8 w-8" />
              </Button>
            </>
          )}

          {/* Image */}
          <div
            className="max-w-[90vw] max-h-[90vh] overflow-y-auto flex flex-col items-center"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={imageFileUrl(selectedImage.id)}
              alt={selectedImage.prompt}
              className="max-w-full max-h-[70vh] object-contain rounded-lg"
            />
            <div className="mt-4 text-center max-w-2xl flex-shrink-0 pb-4">
              <p className="text-white/90 text-sm">{selectedImage.prompt}</p>
              <p className="text-white/50 text-xs mt-1">
                {formatDateTime(selectedImage.createdAt)}
              </p>
              <div className="mt-3 flex justify-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="bg-white/10 border-white/20 text-white hover:bg-white/20"
                  onClick={(e) => handleDownload(selectedImage, e)}
                >
                  <Download className="h-4 w-4 mr-2" />
                  Download
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="bg-red-500/20 border-red-500/30 text-red-400 hover:bg-red-500/30"
                  onClick={(e) => handleDelete(selectedImage.id, e)}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </Button>
              </div>
            </div>
          </div>

          {/* Image counter */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/70 text-sm">
            {selectedIndex + 1} / {images.length}
          </div>
        </div>
      )}
    </>
  );
}
