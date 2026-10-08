import React, { useEffect, useMemo, useRef } from 'react';
import {
    AreaSeries,
    CandlestickSeries,
    ColorType,
    createChart,
    HistogramSeries,
    type AreaData,
    type CandlestickData,
    type HistogramData,
    type IChartApi,
    type Time,
    type UTCTimestamp,
} from 'lightweight-charts';

export interface PortfolioChartPoint {
    price: number;
    open?: number | null;
    high?: number | null;
    low?: number | null;
    close?: number | null;
    volume?: number | null;
    timestamp: number;
}

interface PortfolioPriceChartProps {
    points: PortfolioChartPoint[];
    height?: number;
    isPositive: boolean;
}

const toChartTime = (timestamp: number): Time => Math.floor(timestamp / 1000) as UTCTimestamp;

const isPositiveFinite = (value: unknown): value is number => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0;
};

function normalizePoints(points: PortfolioChartPoint[]) {
    const byTime = new Map<number, PortfolioChartPoint>();
    for (const point of points) {
        if (!Number.isFinite(point.timestamp) || !isPositiveFinite(point.price)) continue;
        byTime.set(Math.floor(point.timestamp / 1000), point);
    }

    return Array.from(byTime.entries())
        .sort(([left], [right]) => left - right)
        .map(([, point]) => point);
}

function toCandles(points: PortfolioChartPoint[]): CandlestickData[] {
    return points
        .filter((point) =>
            isPositiveFinite(point.open)
            && isPositiveFinite(point.high)
            && isPositiveFinite(point.low)
            && isPositiveFinite(point.close ?? point.price)
        )
        .map((point) => ({
            time: toChartTime(point.timestamp),
            open: Number(point.open),
            high: Number(point.high),
            low: Number(point.low),
            close: Number(point.close ?? point.price),
        }));
}

function toArea(points: PortfolioChartPoint[]): AreaData[] {
    return points.map((point) => ({
        time: toChartTime(point.timestamp),
        value: Number(point.close ?? point.price),
    }));
}

function toVolume(points: PortfolioChartPoint[]): HistogramData[] {
    return points
        .filter((point) => Number.isFinite(point.volume ?? NaN) && Number(point.volume) > 0)
        .map((point) => {
            const close = Number(point.close ?? point.price);
            const open = Number(point.open ?? close);
            return {
                time: toChartTime(point.timestamp),
                value: Number(point.volume),
                color: close >= open ? 'rgba(34, 197, 94, 0.28)' : 'rgba(239, 68, 68, 0.26)',
            };
        });
}

const PortfolioPriceChart: React.FC<PortfolioPriceChartProps> = ({ points, height = 260, isPositive }) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const normalizedPoints = useMemo(() => normalizePoints(points), [points]);
    const candleData = useMemo(() => toCandles(normalizedPoints), [normalizedPoints]);
    const areaData = useMemo(() => toArea(normalizedPoints), [normalizedPoints]);
    const volumeData = useMemo(() => toVolume(normalizedPoints), [normalizedPoints]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container || normalizedPoints.length === 0) return;

        const chart = createChart(container, {
            width: container.clientWidth,
            height,
            autoSize: false,
            layout: {
                background: { type: ColorType.Solid, color: 'transparent' },
                textColor: '#94a3b8',
                fontFamily: 'JetBrains Mono, ui-monospace, SFMono-Regular, monospace',
                fontSize: 11,
            },
            grid: {
                vertLines: { color: 'rgba(148, 163, 184, 0.08)' },
                horzLines: { color: 'rgba(148, 163, 184, 0.12)' },
            },
            crosshair: {
                horzLine: { color: 'rgba(226, 232, 240, 0.38)', labelBackgroundColor: '#0f172a' },
                vertLine: { color: 'rgba(226, 232, 240, 0.38)', labelBackgroundColor: '#0f172a' },
            },
            rightPriceScale: {
                borderColor: 'rgba(148, 163, 184, 0.18)',
                scaleMargins: { top: 0.08, bottom: volumeData.length > 0 ? 0.24 : 0.08 },
            },
            timeScale: {
                borderColor: 'rgba(148, 163, 184, 0.18)',
                timeVisible: false,
                secondsVisible: false,
            },
            localization: {
                priceFormatter: (price: number) => `$${price.toFixed(price >= 100 ? 2 : 3)}`,
            },
        });

        if (candleData.length >= Math.max(2, Math.floor(normalizedPoints.length * 0.6))) {
            const candleSeries = chart.addSeries(CandlestickSeries, {
                upColor: '#22c55e',
                downColor: '#ef4444',
                borderVisible: false,
                wickUpColor: '#86efac',
                wickDownColor: '#fca5a5',
                priceLineColor: isPositive ? '#22c55e' : '#ef4444',
            });
            candleSeries.setData(candleData);
        } else {
            const areaSeries = chart.addSeries(AreaSeries, {
                lineColor: isPositive ? '#22c55e' : '#ef4444',
                topColor: isPositive ? 'rgba(34, 197, 94, 0.30)' : 'rgba(239, 68, 68, 0.28)',
                bottomColor: 'rgba(15, 23, 42, 0)',
                lineWidth: 2,
                priceLineColor: isPositive ? '#22c55e' : '#ef4444',
            });
            areaSeries.setData(areaData);
        }

        if (volumeData.length > 0) {
            const volumeSeries = chart.addSeries(HistogramSeries, {
                priceFormat: { type: 'volume' },
                priceScaleId: 'volume',
            });
            volumeSeries.priceScale().applyOptions({
                scaleMargins: { top: 0.78, bottom: 0 },
                borderVisible: false,
            });
            volumeSeries.setData(volumeData);
        }

        chart.timeScale().fitContent();
        chartRef.current = chart;

        const resizeObserver = new ResizeObserver(([entry]) => {
            const width = Math.floor(entry.contentRect.width);
            if (width > 0) {
                chart.applyOptions({ width, height });
                chart.timeScale().fitContent();
            }
        });
        resizeObserver.observe(container);

        return () => {
            resizeObserver.disconnect();
            chart.remove();
            chartRef.current = null;
        };
    }, [areaData, candleData, height, isPositive, normalizedPoints.length, volumeData]);

    if (normalizedPoints.length === 0) {
        return (
            <div
                data-testid="portfolio-price-chart-empty"
                style={{
                    height,
                    border: '1px solid var(--ap-border)',
                    borderRadius: 8,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--ap-text-muted)',
                    fontSize: 12,
                }}
            >
                Market history unavailable
            </div>
        );
    }

    return (
        <div
            data-testid="portfolio-price-chart-canvas"
            ref={containerRef}
            style={{
                height,
                minWidth: 0,
                width: '100%',
            }}
        />
    );
};

export default PortfolioPriceChart;
