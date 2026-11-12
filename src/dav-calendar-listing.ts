/** Parse a bounded DAV multistatus without accepting DTDs or namespace lookalikes. */
export interface DAVCalendarEntry {
  href: string;
  collection: boolean;
  calendar: boolean;
  calendarObject: boolean;
  supportsVTODO?: boolean;
}

export function parseDAVCalendarListing(xml: string): DAVCalendarEntry[] {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) throw new Error('DAV document types and entities are not supported');
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const root = document.documentElement;
  if (root.namespaceURI !== 'DAV:' || root.localName !== 'multistatus' || document.getElementsByTagName('parsererror').length) throw new Error('Expected a valid DAV multistatus response');
  const responses = Array.from(root.children);
  if (responses.length > 20_001) throw new Error('CalDAV collection exceeds the 20,000-object limit');
  const children = (element: Element, namespace: string, name: string): Element[] => Array.from(element.children).filter((child) => child.namespaceURI === namespace && child.localName === name);
  return responses.map((response) => {
    if (response.namespaceURI !== 'DAV:' || response.localName !== 'response') throw new Error('Unexpected DAV multistatus child');
    const hrefs = children(response, 'DAV:', 'href');
    if (hrefs.length !== 1 || !hrefs[0].textContent?.trim()) throw new Error('DAV response must contain one nonempty href');
    const props: Element[] = [];
    for (const propstat of children(response, 'DAV:', 'propstat')) {
      const status = children(propstat, 'DAV:', 'status')[0]?.textContent ?? '';
      if (/^HTTP\/\S+ 200(?:\s|$)/u.test(status)) props.push(...children(propstat, 'DAV:', 'prop').flatMap((prop) => Array.from(prop.children)));
    }
    const types = props.filter((prop) => prop.namespaceURI === 'DAV:' && prop.localName === 'resourcetype').flatMap((prop) => Array.from(prop.children));
    const collection = types.some((type) => type.namespaceURI === 'DAV:' && type.localName === 'collection');
    const calendar = types.some((type) => type.namespaceURI === 'urn:ietf:params:xml:ns:caldav' && type.localName === 'calendar');
    const componentSets = props.filter((prop) => prop.namespaceURI === 'urn:ietf:params:xml:ns:caldav' && prop.localName === 'supported-calendar-component-set');
    const supportsVTODO = componentSets.length ? componentSets.some((set) => children(set, 'urn:ietf:params:xml:ns:caldav', 'comp').some((component) => component.getAttribute('name') === 'VTODO')) : undefined;
    const calendarObject = props.some((prop) => (prop.namespaceURI === 'DAV:' && prop.localName === 'getcontenttype' && /^text\/calendar(?:;|$)/iu.test(prop.textContent?.trim() ?? '')) || (prop.namespaceURI === 'DAV:' && prop.localName === 'getetag' && Boolean(prop.textContent?.trim())));
    if (!props.length) throw new Error('DAV response did not provide readable resource properties');
    return { href: hrefs[0].textContent?.trim() ?? '', collection, calendar, calendarObject, supportsVTODO };
  });
}
