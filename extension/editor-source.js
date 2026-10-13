import { Editor, Extension, Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { TextSelection, EditorState } from '@tiptap/pm/state';

const blockTypes = ['paragraph','heading','blockquote','bulletList','orderedList','taskList','codeBlock','horizontalRule','table','image'];
const SourceIds = Extension.create({
  name: 'sourceIds',
  addGlobalAttributes() {
    return [{ types: blockTypes, attributes: { sourceId: { default: null, rendered: false, parseHTML: () => null } } }];
  }
});
function clean(node) {
  const result = { ...node };
  if (result.attrs) {
    result.attrs = { ...result.attrs }; delete result.attrs.sourceId;
    if (!Object.keys(result.attrs).length) delete result.attrs;
  }
  if (result.content) result.content = result.content.map(clean);
  return result;
}
const fingerprint = node => JSON.stringify(clean(node));
const containsHtml = tokens => (tokens || []).some(token => token.type === 'html' || containsHtml(token.tokens) || (token.items || []).some(item => containsHtml(item.tokens)));

export class RichMarkdown {
  constructor(element, callbacks) {
    this.callbacks = callbacks; this.records = new Map(); this.originalText = ''; this.markdown = ''; this.loading = false;
    const resource = callbacks.image;
    const LocalImage = Image.extend({
      addNodeView() {
        return ({ node }) => {
          const dom = document.createElement('span'); dom.className = 'local-image'; dom.contentEditable = 'false';
          const fallback = document.createElement('span'); fallback.className = 'image-placeholder';
          fallback.textContent = `图片：${node.attrs.alt || node.attrs.src}`; dom.append(fallback);
          let alive = true; let url;
          resource(node.attrs.src).then(blob => {
            if (!alive || !blob) return;
            url = URL.createObjectURL(blob); const img = document.createElement('img');
            img.alt = node.attrs.alt || ''; img.title = node.attrs.title || ''; img.src = url;
            img.onerror = () => img.replaceWith(fallback); dom.replaceChildren(img);
          }).catch(() => {});
          return { dom, destroy() { alive = false; if (url) URL.revokeObjectURL(url); } };
        };
      }
    }).configure({ inline: true, allowBase64: false });
    const Preserved = Node.create({
      name:'preservedMarkdown', group:'block', atom:true,
      addAttributes() { return { raw:{default:''}, hidden:{default:false} }; },
      renderHTML() { return ['div', {'data-preserved-markdown':''}]; },
      addNodeView() {
        return ({node}) => {
          const dom=document.createElement('div'); dom.className='preserved-markdown'; dom.contentEditable='false';
          dom.hidden=node.attrs.hidden;
          const fragment=DOMPurify.sanitize(marked.parse(node.attrs.raw),{
            RETURN_DOM_FRAGMENT:true, USE_PROFILES:{html:true},
            FORBID_TAGS:['style','script','form','input','button','textarea','select','video','audio','iframe','object','embed'],
            FORBID_ATTR:['style','srcset','id','name','target']
          });
          const urls=[]; let alive=true;
          for(const img of fragment.querySelectorAll('img')) {
            const src=img.getAttribute('src'); img.removeAttribute('src');
            const label=document.createElement('span'); label.className='image-placeholder'; label.textContent=`图片：${img.alt || src}`;
            img.replaceWith(label);
            resource(src).then(blob=>{ if(!alive || !blob)return; const url=URL.createObjectURL(blob); urls.push(url); img.src=url; img.onerror=()=>img.replaceWith(label); label.replaceWith(img); }).catch(()=>{});
          }
          dom.append(fragment);
          return {dom,destroy(){alive=false;urls.forEach(URL.revokeObjectURL);}};
        };
      }
    });
    this.editor = new Editor({
      element, injectCSS:false,
      extensions:[
        StarterKit.configure({ underline:false, trailingNode:false, link:{openOnClick:false, autolink:false} }),
        Markdown.configure({ markedOptions:{gfm:true} }), TableKit.configure({table:{resizable:false}}),
        TaskList, TaskItem.configure({nested:true}), LocalImage, SourceIds, Preserved
      ],
      content:{type:'doc',content:[{type:'paragraph'}]},
      editorProps:{
        attributes:{ class:'markdown rich-editor', role:'textbox', 'aria-label':'可直接编辑的 Markdown 正文', 'aria-multiline':'true', spellcheck:'false' },
        transformPastedHTML:html=>DOMPurify.sanitize(html,{USE_PROFILES:{html:true},FORBID_TAGS:['style','script','iframe','object','embed'],FORBID_ATTR:['style','srcset','id','name']}),
        handleClick:(view,pos,event)=>{
          const link=event.target.closest('a');
          if(link && (event.ctrlKey || event.metaKey)) { event.preventDefault(); callbacks.link(link.getAttribute('href')); return true; }
          if(link) event.preventDefault();
          return false;
        },
        handleDOMEvents:{
          pointerdown:()=>{callbacks.authorize();return false;},
          keydown:()=>{callbacks.authorize();return false;},
          compositionstart:()=>{callbacks.composing(true);return false;},
          compositionend:()=>{queueMicrotask(()=>callbacks.composing(false));return false;}
        }
      },
      onUpdate:()=>{
        if(this.loading)return;
        this.markdown=this.serialize(); callbacks.change(this.markdown); callbacks.outline(this.headings());
      }
    });
  }
  load(text, preserveSelection = false) {
    if(text === this.markdown && this.originalDoc) return;
    const selection=this.editor.state.selection; const focused=this.editor.isFocused;
    this.records.clear(); this.originalText=text; this.markdown=text;
    const tokens=marked.lexer(text,{gfm:true});
    const definitions=tokens.filter(token=>token.type==='def').map(token=>token.raw).join('\n');
    const content=[]; let prefix=''; let lastRecord=null;
    for(const token of tokens) {
      if(token.type==='space') {
        if(lastRecord)lastRecord.raw+=token.raw; else prefix+=token.raw;
        continue;
      }
      if(token.type==='def' || token.type==='html' || containsHtml(token.tokens) || containsHtml(token.items?.flatMap(item=>item.tokens || []))) {
        content.push({type:'preservedMarkdown',attrs:{raw:prefix+token.raw,hidden:token.type==='def'}}); prefix=''; lastRecord=null; continue;
      }
      let parsed=this.editor.markdown.parse(token.raw + (definitions?'\n\n'+definitions:''));
      const nodes=parsed.content || [];
      if(!nodes.length) { content.push({type:'preservedMarkdown',attrs:{raw:prefix+token.raw,hidden:true}}); prefix='';lastRecord=null;continue; }
      // Most Markdown block tokens map to a single rich block. Multi-node
      // constructs remain atomic to keep their original source intact.
      if(nodes.length !== 1) { content.push({type:'preservedMarkdown',attrs:{raw:prefix+token.raw,hidden:false}}); prefix='';lastRecord=null;continue; }
      const node=nodes[0]; const id=crypto.randomUUID(); node.attrs={...node.attrs,sourceId:id};
      const normalized=this.editor.schema.nodeFromJSON(node).toJSON();
      lastRecord={raw:prefix+token.raw,fingerprint:fingerprint(normalized)}; prefix='';
      this.records.set(id,lastRecord);content.push(normalized);
    }
    if(prefix)content.push({type:'preservedMarkdown',attrs:{raw:prefix,hidden:true}});
    if(!content.length)content.push({type:'paragraph'});
    this.loading=true;
    try {
      this.editor.commands.setContent({type:'doc',content},{emitUpdate:false});
      this.editor.view.updateState(EditorState.create({ schema:this.editor.schema, doc:this.editor.state.doc, plugins:this.editor.state.plugins }));
      this.originalDoc=fingerprint(this.editor.getJSON());
      if(preserveSelection) {
        const max=this.editor.state.doc.content.size;
        this.editor.view.dispatch(this.editor.state.tr.setSelection(TextSelection.near(this.editor.state.doc.resolve(Math.min(selection.from,max)))));
        if(focused)this.editor.view.focus();
      }
    } finally {this.loading=false;}
    this.callbacks.outline(this.headings());
  }
  serialize() {
    const json=this.editor.getJSON();
    if(fingerprint(json)===this.originalDoc)return this.originalText;
    let result='';
    for(const node of json.content || []) {
      const original=this.records.get(node.attrs?.sourceId);
      let raw;
      if(node.type==='preservedMarkdown')raw=node.attrs.raw;
      else if(original && original.fingerprint===fingerprint(node))raw=original.raw;
      else {
        raw=this.editor.markdown.serialize({type:'doc',content:[clean(node)]});
        if(!raw && node.type==='paragraph')raw='\n';
      }
      if(result && !result.endsWith('\n\n') && !raw.startsWith('\n')) result+='\n'.repeat(result.endsWith('\n')?1:2);
      result+=raw;
    }
    return result;
  }
  headings() {
    const headings=[];this.editor.state.doc.descendants((node,pos)=>{if(node.type.name==='heading')headings.push({text:node.textContent,level:node.attrs.level,pos});});return headings;
  }
  jump(position) {this.editor.commands.setTextSelection(position+1);this.editor.commands.scrollIntoView();}
  getCaret(){return this.editor.state.selection.from;}
  restoreCaret(position){if(position)this.editor.commands.setTextSelection(Math.min(position,this.editor.state.doc.content.size));}
  focus(){this.editor.commands.focus();}
  destroy(){this.editor.destroy();}
}
