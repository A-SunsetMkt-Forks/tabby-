import React, {
  forwardRef,
  HTMLAttributes,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import Mention from '@tiptap/extension-mention'
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react'
import { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion'
import { uniqBy } from 'lodash-es'
import { FileBox, FileText, Loader2, SquareFunctionIcon } from 'lucide-react'
import {
  ChangeItem,
  GetChangesParams,
  ListFileItem,
  ListFilesInWorkspaceParams,
  ListSymbolItem,
  ListSymbolsParams
} from 'tabby-chat-panel/index'

import { useDebounceValue } from '@/lib/hooks/use-debounce'
import {
  cn,
  convertFromFilepath,
  resolveDirectoryPath,
  resolveFileNameForDisplay
} from '@/lib/utils'
import { IconChevronLeft, IconChevronRight } from '@/components/ui/icons'

import type { CategoryItem, CategoryMenu, FileItem, SourceItem } from '../types'
import { formatFileDescription } from './helper'
import {
  commandItemToSourceItem,
  createChangesCommand,
  fileItemToSourceItem,
  symbolItemToSourceItem
} from './utils'

/**
 * A React component to render a mention node in the editor.
 * Displays the filename and an icon in a highlighted style.
 */
export const MentionComponent = ({ node }: { node: any }) => {
  const { category, label } = node.attrs

  return (
    <NodeViewWrapper as="span" className="rounded-sm px-1">
      <span
        className={cn(
          'space-x-0.5 whitespace-nowrap rounded bg-muted px-1.5 py-0.5 align-middle text-sm font-medium text-foreground'
        )}
        data-category={category}
      >
        {category === 'file' ? (
          <FileText className="relative -top-px inline-block h-3.5 w-3.5" />
        ) : category === 'symbol' ? (
          <SquareFunctionIcon className="relative -top-px inline-block h-3.5 w-3.5" />
        ) : (
          <FileBox className="relative -top-px inline-block h-3.5 w-3.5" />
        )}
        <span className="relative whitespace-normal">{label}</span>
      </span>
    </NodeViewWrapper>
  )
}
/**
 * A custom TipTap extension to handle file mentions (like @filename).
 * When converted to plain text, it produces a placeholder with file info.
 */
export const PromptFormMentionExtension = Mention.extend({
  // Uses ReactNodeViewRenderer for custom node rendering
  addNodeView() {
    return ReactNodeViewRenderer(MentionComponent)
  },

  // When exported as plain text, use a placeholder format
  renderText({ node }) {
    const category = node.attrs.category

    // If symbols can be mentioned later, the placeholder could be [[symbol:{label}]].
    switch (category) {
      case 'command':
        return `[[contextCommand:${node.attrs.command || 'default'}]]`
      case 'symbol':
        return `[[symbol:${JSON.stringify(node.attrs.fileItem)}]]`
      case 'file':
      default:
        const fileItem = node.attrs.fileItem
        const filePath = fileItem.filepath
        return `[[file:${JSON.stringify(filePath)}]]`
    }
  },

  // Defines custom attributes for the mention node
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: element => element.getAttribute('data-file'),
        renderHTML: attrs => {
          if (!attrs.fileItem) return {}
          return { 'data-id': JSON.stringify(attrs.fileItem.filepath) }
        }
      },
      fileItem: {
        default: null,
        parseHTML: element => element.getAttribute('data-file'),
        renderHTML: attrs => {
          if (!attrs.fileItem) return {}
          return { 'data-file': attrs.fileItem }
        }
      },
      category: {
        default: 'file',
        parseHTML: element => element.getAttribute('data-category'),
        renderHTML: attrs => {
          if (!attrs.category) return {}
          return { 'data-category': attrs.category }
        }
      },
      command: {
        default: null,
        parseHTML: element => element.getAttribute('data-command'),
        renderHTML: attrs => {
          if (!attrs.command) return {}
          return { 'data-command': attrs.command }
        }
      },
      // label could be basename of path or symbol name
      label: {
        default: '',
        parseHTML: element => element.getAttribute('data-label'),
        renderHTML: attrs => {
          if (!attrs.label) return {}
          return { 'data-label': attrs.label }
        }
      }
    }
  }
})

export interface MentionListActions {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean
}

export interface MentionListProps extends SuggestionProps {
  items: SourceItem[]
  listFileInWorkspace?: (
    params: ListFilesInWorkspaceParams
  ) => Promise<ListFileItem[]>
  listSymbols?: (params: ListSymbolsParams) => Promise<ListSymbolItem[]>
  getChanges?: (param: GetChangesParams) => Promise<ChangeItem[]>
  onSelectItem: (item: SourceItem) => void
}

/**
 * A React component for the mention dropdown list.
 * Displays when a user types '@...' and suggestions are fetched.
 */
export const MentionList = forwardRef<MentionListActions, MentionListProps>(
  (
    {
      items: propItems,
      command,
      query,
      listFileInWorkspace,
      listSymbols,
      getChanges
    },
    ref
  ) => {
    const [items, setItems] = useState<SourceItem[]>(propItems)
    const [selectedIndex, setSelectedIndex] = useState(0)
    const [mode, setMode] = useState<CategoryMenu>('category')
    const [isLoading, setIsLoading] = useState(false)
    const [debouncedIsLoading] = useDebounceValue(isLoading, 100)
    const [isFirstShow, setIsFirstShow] = useState(true)
    const [debouncedQuery] = useDebounceValue(query || '', 150)
    const latestPromiseRef = useRef<Promise<SourceItem[]> | null>(null)

    const categories = useMemo(() => {
      const items = [
        listFileInWorkspace && {
          label: 'Files',
          categoryKind: 'file' as const,
          icon: <FileText className="h-4 w-4" />
        },
        listSymbols && {
          label: 'Symbols',
          categoryKind: 'symbol' as const,
          icon: <SquareFunctionIcon className="h-4 w-4" />
        }
      ].filter(Boolean) as CategoryItem[]

      if (items.length === 1) {
        setMode(items[0].categoryKind)
      }
      return items
    }, [listFileInWorkspace, listSymbols])

    const isSingleMode = categories.length === 1
    const shouldShowCategoryMenu = !isSingleMode && mode === 'category'

    const fetchOptions = useCallback(async () => {
      setIsLoading(true)
      let isCurrent = true

      try {
        const currentQuery = isFirstShow ? query : debouncedQuery

        if (latestPromiseRef.current) {
          ;(latestPromiseRef.current as any).isCurrent = false
        }

        const currentPromise = (async () => {
          let result: SourceItem[] = []
          if (shouldShowCategoryMenu) {
            const files =
              (await listFileInWorkspace?.({ query: currentQuery || '' })) || []

            if (currentQuery) {
              // TODO(Sma1lboy): refactor this part as function if more context coimmand/category join
              const changesCommand = getChanges
                ? [commandItemToSourceItem(createChangesCommand())]
                : []
              const fileItems = files.map(fileItemToSourceItem)

              if (
                getChanges &&
                createChangesCommand()
                  .name.toLowerCase()
                  .startsWith(currentQuery.toLowerCase())
              ) {
                result = [...changesCommand, ...fileItems]
              } else {
                result = fileItems
              }
            } else {
              // No query, show categories and top-level items
              result = [
                ...categories.map(
                  c =>
                    ({
                      id: c.categoryKind,
                      name: c.label,
                      category: 'category',
                      isRootCategoryItem: true,
                      fileItem: {} as FileItem,
                      icon: c.icon
                    } as SourceItem)
                ),
                // Only add the changes command if getChanges is available
                ...(getChanges
                  ? [commandItemToSourceItem(createChangesCommand())]
                  : []),
                ...files.map(fileItemToSourceItem)
              ]
            }
          } else {
            if (mode === 'file') {
              const files =
                (await listFileInWorkspace?.({ query: currentQuery })) || []
              result = files.map(fileItemToSourceItem)
            } else {
              const symbols =
                (await listSymbols?.({ query: currentQuery })) || []
              result = uniqBy(symbols.map(symbolItemToSourceItem), 'id')
            }
          }
          return result
        })()

        ;(currentPromise as any).isCurrent = true
        latestPromiseRef.current = currentPromise

        const results = await currentPromise

        const processedResults = results.map(item => {
          if (item.category === 'file' && item.fileItem) {
            try {
              const fileData = convertFromFilepath(item.fileItem.filepath)

              item.description = formatFileDescription(fileData)
            } catch (error) {}
          }
          return item
        })

        if ((latestPromiseRef.current as any)?.isCurrent) {
          setItems(processedResults)
          setSelectedIndex(0)
          setIsLoading(false)
          if (isFirstShow) setIsFirstShow(false)
        }
      } catch (error) {
        if (isCurrent) {
          setIsLoading(false)
        }
      }
    }, [
      categories,
      debouncedQuery,
      isFirstShow,
      listFileInWorkspace,
      listSymbols,
      getChanges,
      mode,
      query,
      shouldShowCategoryMenu
    ])

    useEffect(() => {
      fetchOptions()
    }, [
      mode,
      query,
      debouncedQuery,
      isFirstShow,
      shouldShowCategoryMenu,
      fetchOptions
    ])

    useEffect(() => {
      return () => {
        if (latestPromiseRef.current) {
          ;(latestPromiseRef.current as any).isCurrent = false
        }
      }
    }, [])

    const handleSelect = (item: SourceItem) => {
      if (item.isRootCategoryItem && !isSingleMode) {
        setMode(item.id as CategoryMenu)
        return
      }

      if (item.category === 'command') {
        command({
          category: 'command',
          command: item.name,
          label: item.name
        })
        return
      }

      const label =
        item.category === 'file'
          ? resolveFileNameForDisplay(
              convertFromFilepath(item.fileItem!.filepath).filepath || ''
            )
          : item.name

      command({
        category: item.category as 'file' | 'symbol',
        fileItem: item.fileItem,
        label
      })
    }

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (isLoading) {
          return false
        }
        const lastIndex = items.length - 1
        let newIndex = selectedIndex

        switch (event.key) {
          case 'ArrowUp':
            newIndex = Math.max(0, selectedIndex - 1)
            break
          case 'ArrowDown':
            newIndex = Math.min(lastIndex, selectedIndex + 1)
            break
          case 'Enter':
            if (items[selectedIndex]) {
              handleSelect(items[selectedIndex])
              if (items[selectedIndex].isRootCategoryItem) {
                setSelectedIndex(0)
              }
            }
            return true
          default:
            return false
        }

        setSelectedIndex(newIndex)
        return true
      }
    }))

    return (
      <div className="relative flex max-h-[300px] w-[80vw] flex-col overflow-hidden rounded-md border bg-background p-1 sm:w-[420px]">
        {debouncedIsLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/80">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        )}
        {!isSingleMode && mode !== 'category' && (
          <div className="flex items-center p-1 text-sm text-muted-foreground">
            <button
              className="mr-2 rounded p-1 hover:bg-accent"
              onClick={() => setMode('category')}
            >
              <IconChevronLeft className="h-4 w-4" />
            </button>
            {mode === 'file' ? 'Files' : 'Symbols'}
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              {/* If no items are found, show a message. */}
              {query ? 'No results found' : 'Type to search...'}
            </div>
          ) : (
            <div className="grid gap-0.5">
              {items.map((item, index) => (
                <OptionItemView
                  key={`${item.id}-${index}`}
                  onClick={() => handleSelect(item)}
                  onMouseEnter={() => setSelectedIndex(index)}
                  title={item.name}
                  isSelected={index === selectedIndex}
                  data={item}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }
)
MentionList.displayName = 'MentionList'

interface OptionItemView extends HTMLAttributes<HTMLDivElement> {
  isSelected: boolean
  data: SourceItem
}

function OptionItemView({ isSelected, data, ...rest }: OptionItemView) {
  const ref = useRef<HTMLDivElement>(null)
  const filepathWithoutFilename = useMemo(() => {
    return resolveDirectoryPath(data.filepath || '')
  }, [data.filepath])

  useLayoutEffect(() => {
    if (isSelected && ref.current) {
      ref.current?.scrollIntoView({
        block: 'nearest',
        inline: 'nearest'
      })
    }
  }, [isSelected])

  return (
    <div
      className={cn(
        'flex cursor-pointer flex-nowrap items-center gap-1 overflow-hidden rounded-md px-2 py-1.5 text-sm',
        {
          'bg-accent text-accent-foreground': isSelected
        }
      )}
      {...rest}
      ref={ref}
    >
      <span className="flex h-5 shrink-0 items-center">{data.icon}</span>
      <span className="mr-2 truncate whitespace-nowrap">{data.name}</span>
      {data.description && (
        <span className="flex-1 truncate text-xs text-muted-foreground">
          {data.description}
        </span>
      )}
      {data.category === 'file' && !data.description && (
        <span className="flex-1 truncate text-xs text-muted-foreground">
          {filepathWithoutFilename}
        </span>
      )}
      {data.category === 'category' && (
        <IconChevronRight className="h-4 w-4 text-muted-foreground" />
      )}
    </div>
  )
}
