//! Microsoft Windows Update FE3 client (for legacy UWP packages).
//!
//! Modern GDK versions ship their direct CDN URLs in the community catalog, but
//! legacy UWP versions are catalogued only by their Windows Update *UpdateID*.
//! To get a real download link we ask Microsoft's FE3 delivery service, exactly
//! like the Windows Store client does: a single `GetExtendedUpdateInfo2` SOAP
//! call with the UpdateID + revision number.
//!
//! For **release** packages this works anonymously (no Microsoft account). Beta
//! builds would need an MSA token, which we don't implement.

const SECURED_URL: &str =
    "https://fe3.delivery.mp.microsoft.com/ClientWebService/client.asmx/secured";

// A trimmed-down but accepted device-attributes string (entity-escaped).
const DEVICE_ATTRIBUTES: &str = "E:BranchReadinessLevel=CBB&amp;OSArchitecture=AMD64&amp;App=WU&amp;InstallationType=Client&amp;AppVer=10.0.17134.471&amp;OSVersion=10.0.17134.472&amp;DeviceFamily=Windows.Desktop";

fn build_request(update_id: &str, revision: u32) -> String {
    format!(
        r#"<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing"><s:Header><a:Action s:mustUnderstand="1">http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService/GetExtendedUpdateInfo2</a:Action><a:MessageID>urn:uuid:a68d4c75-ab85-4ca8-87db-136d281a2e28</a:MessageID><a:To s:mustUnderstand="1">{url}</a:To><o:Security s:mustUnderstand="1" xmlns:o="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><Timestamp xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"><Created>2019-01-01T00:00:00.000Z</Created><Expires>2100-01-01T00:00:00.000Z</Expires></Timestamp><wuws:WindowsUpdateTicketsToken wsu:id="ClientMSA" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" xmlns:wuws="http://schemas.microsoft.com/msus/2014/10/WindowsUpdateAuthorization"><TicketType Name="AAD" Version="1.0" Policy="MBI_SSL"/></wuws:WindowsUpdateTicketsToken></o:Security></s:Header><s:Body><GetExtendedUpdateInfo2 xmlns="http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService"><updateIDs><UpdateIdentity><UpdateID>{id}</UpdateID><RevisionNumber>{rev}</RevisionNumber></UpdateIdentity></updateIDs><infoTypes><XmlUpdateFragmentType>FileUrl</XmlUpdateFragmentType></infoTypes><deviceAttributes>{da}</deviceAttributes></GetExtendedUpdateInfo2></s:Body></s:Envelope>"#,
        url = SECURED_URL,
        id = update_id,
        rev = revision,
        da = DEVICE_ATTRIBUTES,
    )
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

/// Extract all `<Url>…</Url>` values from the SOAP response.
fn extract_urls(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<Url>") {
        let after = &rest[start + 5..];
        if let Some(end) = after.find("</Url>") {
            out.push(decode_entities(&after[..end]));
            rest = &after[end + 6..];
        } else {
            break;
        }
    }
    out
}

/// Resolve a downloadable URL for a UWP package by its Windows Update UpdateID.
/// Prefers the signed `tlu.dl` CDN edge, falling back to `dl.delivery` origin.
pub async fn resolve_download_url(update_id: &str, revision: u32) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("Windows-Update-Agent/10.0.10011.16384 Client-Protocol/1.81")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post(SECURED_URL)
        .header("Content-Type", "application/soap+xml; charset=utf-8")
        .body(build_request(update_id, revision))
        .send()
        .await
        .map_err(|e| format!("ERR_FE3_REQUEST: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("ERR_FE3_HTTP_{}", resp.status().as_u16()));
    }
    let xml = resp.text().await.map_err(|e| e.to_string())?;
    let urls = extract_urls(&xml);
    if urls.is_empty() {
        return Err("ERR_FE3_NO_LINK".into());
    }
    if let Some(u) = urls.iter().find(|u| u.contains("tlu.dl.delivery.mp.microsoft.com")) {
        return Ok(u.clone());
    }
    if let Some(u) = urls.iter().find(|u| u.contains("dl.delivery.mp.microsoft.com")) {
        return Ok(u.clone());
    }
    Ok(urls[0].clone())
}
