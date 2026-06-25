function downloadXYZ(points) {
    let txt = "";
    for (let p of points) {
        txt += `${p.x} ${p.y} ${p.z}\n`;
    }

    const blob = new Blob([txt], {type: 'text/plain'});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "merged.xyz";
    a.click();
}
