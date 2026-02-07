import { describe, expect, it } from 'vitest';
import { clientToCanvasPoint, getDisplayScale } from '../canvasGeometry';

describe('canvasGeometry.getDisplayScale', () => {
  it('DPR=1 时保持原缩放', () => {
    expect(getDisplayScale(1, 1)).toBe(1);
    expect(getDisplayScale(2, 1)).toBe(2);
  });

  it('DPR>1 时按比例缩小显示', () => {
    expect(getDisplayScale(1, 1.5)).toBeCloseTo(2 / 3);
    expect(getDisplayScale(2, 2)).toBe(1);
  });

  it('非法输入回退到安全值', () => {
    expect(getDisplayScale(0, 2)).toBe(0.5);
    expect(getDisplayScale(1, 0)).toBe(1);
    expect(getDisplayScale(Number.NaN, Number.NaN)).toBe(1);
  });
});

describe('canvasGeometry.clientToCanvasPoint', () => {
  it('按实际渲染尺寸换算到画布像素坐标', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1920;
    canvas.height = 1080;

    const point = clientToCanvasPoint(canvas, 740, 410, {
      left: 100,
      top: 50,
      width: 1280,
      height: 720,
    });

    expect(point.x).toBeCloseTo(960);
    expect(point.y).toBeCloseTo(540);
  });

  it('渲染尺寸异常时使用画布尺寸兜底', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;

    const point = clientToCanvasPoint(canvas, 110, 70, {
      left: 10,
      top: 20,
      width: 0,
      height: 0,
    });

    expect(point.x).toBeCloseTo(100);
    expect(point.y).toBeCloseTo(50);
  });
});
