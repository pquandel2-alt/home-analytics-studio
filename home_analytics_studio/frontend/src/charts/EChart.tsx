import { BarChart, GaugeChart, HeatmapChart, LineChart, PieChart, ScatterChart } from 'echarts/charts'
import {
  CalendarComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  PolarComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { useEffect, useRef } from 'react'

echarts.use([
  LineChart,
  BarChart,
  PieChart,
  GaugeChart,
  HeatmapChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  VisualMapComponent,
  CalendarComponent,
  DataZoomComponent,
  MarkLineComponent,
  PolarComponent,
  CanvasRenderer,
])

export type EChartsOption = echarts.EChartsCoreOption

export function EChart({ option, className, onClick }: { option: EChartsOption; className?: string; onClick?: (p: any) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const chart = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    if (!ref.current) return
    const inst = echarts.init(ref.current, undefined, { renderer: 'canvas' })
    chart.current = inst
    const ro = new ResizeObserver(() => inst.resize())
    ro.observe(ref.current)
    return () => {
      ro.disconnect()
      inst.dispose()
      chart.current = null
    }
  }, [])

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true, lazyUpdate: true })
  }, [option])

  useEffect(() => {
    const inst = chart.current
    if (!inst || !onClick) return
    inst.on('click', onClick)
    return () => {
      inst.off('click', onClick)
    }
  }, [onClick])

  return <div ref={ref} className={className || 'h-full w-full'} />
}
